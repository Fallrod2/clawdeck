// src/deps-http-degradees.test.ts — sondes HTTP face à des dépendances qui
// répondent MAL. Le cas « absente » est déjà couvert ailleurs ; ici Ollama et
// la gateway sont bien là, mais mentent, traînent ou renvoient du charabia.
//
// Chaque cas passe par un VRAI serveur jetable (Bun.serve, port éphémère, lié
// au loopback), comme le relais ntfy de notify.test.ts : un fetch simulé
// vérifierait la doublure, pas la sonde. Statut, corps tronqué, en-têtes sans
// corps ou silence complet ne se distinguent qu'au travers d'une vraie pile
// HTTP. Aucun test ne sort de la machine ni ne touche l'Ollama réel.

import { describe, expect, test } from "bun:test";
import { checkGateway, checkOllama } from "./checks";

const MODELE_REPLI = "qwen3.5:9b";

// Délai court imposé aux sondes : le défaut de production est de 3 s, et
// éprouver une dépendance qui traîne coûterait autant de mur par cas.
const DELAI_TEST_MS = 120;

function serveurJetable(handler: (req: Request) => Response | Promise<Response>) {
  const serveur = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  return {
    url: `http://127.0.0.1:${serveur.port}`,
    // stop(true) coupe aussi les échanges en cours : sans ça, un corps laissé
    // ouvert par un test retiendrait le processus de test.
    stop: () => serveur.stop(true),
  };
}

async function avecServeur<T>(
  handler: (req: Request) => Response | Promise<Response>,
  cas: (url: string) => Promise<T>,
): Promise<T> {
  const serveur = serveurJetable(handler);
  try {
    return await cas(serveur.url);
  } finally {
    serveur.stop();
  }
}

describe("Ollama qui répond mal", () => {
  test("vivant mais sans le modèle de repli : jamais annoncé prêt", async () => {
    // Le repli local peut prendre la main sans prévenir (voir docs/PROJET.md) :
    // si son tag n'est plus chargé, la bascule échouerait au pire moment.
    // « Ollama répond » et « le repli est prêt » sont deux faits distincts, et
    // le second ne se déduit jamais du premier.
    const listeVide = await avecServeur(
      () => Response.json({ models: [] }),
      (url) => checkOllama(url, MODELE_REPLI),
    );
    expect(listeVide.ok).toBe(true);
    expect(listeVide.fallbackModelReady).toBe(false);

    // Tags voisins mais différents : la comparaison doit rester exacte, un
    // « qwen3.5:latest » ne prouve rien sur « qwen3.5:9b ».
    const autreTag = await avecServeur(
      () => Response.json({ models: [{ name: "qwen3.5:latest" }, { name: "llama4:8b" }] }),
      (url) => checkOllama(url, MODELE_REPLI),
    );
    expect(autreTag.ok).toBe(true);
    expect(autreTag.fallbackModelReady).toBe(false);
    expect(autreTag.models).toEqual(["qwen3.5:latest", "llama4:8b"]);
  });

  test("200 au corps tronqué : échec explicite, jamais un repli « prêt » par défaut", async () => {
    // Corps coupé en vol (proxy, redémarrage, OOM) : le JSON ne parse pas. Le
    // risque n'est pas l'exception — elle est attrapée — mais qu'un chemin
    // d'erreur laisse `fallbackModelReady` à sa valeur optimiste.
    const resultat = await avecServeur(
      () => new Response('{"models": [{"name": "qwen', {
        headers: { "content-type": "application/json" },
      }),
      (url) => checkOllama(url, MODELE_REPLI),
    );

    expect(resultat.ok).toBe(false);
    expect(resultat.fallbackModelReady).toBeUndefined();
    expect(resultat.models).toBeUndefined();
    // Une sonde rouge sans cause n'est pas exploitable dans une console
    // d'exploitation : il faut toujours pouvoir dire POURQUOI.
    expect(resultat.error).toBeTruthy();
  });

  test("200 au schéma inattendu : le cycle de statut survit, sans conclusion inventée", async () => {
    // `models` qui n'est pas un tableau : c'est le cas qui casse la
    // normalisation naïve. Une exception non attrapée ferait tomber TOUT le
    // cycle de statut (les sondes partagent un Promise.all dans status.ts),
    // donc pings et gateway avec elle.
    for (const corps of [{ models: "qwen3.5:9b" }, { models: { qwen: true } }, null]) {
      const resultat = await avecServeur(
        () => Response.json(corps),
        (url) => checkOllama(url, MODELE_REPLI),
      );
      expect(resultat.ok).toBe(false);
      expect(resultat.fallbackModelReady).toBeUndefined();
      expect(resultat.error).toBeTruthy();
    }
  });

  test("statut d'erreur : la cause est rapportée et la latence mesurée conservée", async () => {
    // « Répond mal » n'est pas « injoignable » : un 503 prouve qu'Ollama écoute
    // encore, et sa latence reste une mesure valide. Les confondre effacerait
    // la différence entre un service saturé et un service éteint.
    const resultat = await avecServeur(
      () => new Response("model runner busy", { status: 503 }),
      (url) => checkOllama(url, MODELE_REPLI),
    );

    expect(resultat.ok).toBe(false);
    expect(resultat.error).toBe("HTTP 503");
    expect(resultat.latencyMs).not.toBeNull();
    expect(resultat.fallbackModelReady).toBeUndefined();
  });

  test("silence complet : la sonde rend la main au délai imparti", async () => {
    // Une dépendance qui ne répond jamais est le pire cas pour la boucle de
    // statut : sans borne, plus aucun instantané ne serait diffusé et le
    // dashboard afficherait une donnée qui vieillit sans dire pourquoi.
    let debloquer: () => void = () => {};
    const enAttente = new Promise<void>((resolve) => {
      debloquer = resolve;
    });

    const serveur = serveurJetable(async () => {
      await enAttente;
      return Response.json({ models: [{ name: MODELE_REPLI }] });
    });
    try {
      const debut = Date.now();
      const resultat = await checkOllama(serveur.url, MODELE_REPLI, DELAI_TEST_MS);
      const ecoule = Date.now() - debut;

      expect(resultat.ok).toBe(false);
      expect(resultat.latencyMs).toBeNull();
      expect(resultat.error).toBeTruthy();
      // La sonde a bien abandonné d'elle-même, et non parce que le serveur a
      // fini par répondre : il n'a toujours rien renvoyé à cet instant.
      expect(ecoule).toBeLessThan(DELAI_TEST_MS * 8);
    } finally {
      debloquer();
      serveur.stop();
    }
  });
});

describe("gateway HTTP qui répond mal", () => {
  test("statut d'erreur : jamais vivante, mais la latence reste mesurée", async () => {
    // La sonde HTTP ne juge que la vivacité ; un 503 dit que le processus
    // écoute sans être en état de servir. La latence connue le distingue d'un
    // port fermé, où elle est nulle.
    // Rien n'est asserté sur la cause : contrairement à la sonde Ollama juste
    // au-dessus, celle-ci n'en rapporte aucune sur un statut d'erreur. C'est
    // un écart constaté, signalé à part, et non une garantie qu'on fige ici.
    const resultat = await avecServeur(
      () => new Response("starting", { status: 503 }),
      (url) => checkGateway(url),
    );

    expect(resultat.ok).toBe(false);
    expect(resultat.latencyMs).not.toBeNull();
  });

  test("port fermé et statut d'erreur ne se confondent pas", async () => {
    // Injoignable : aucune latence à rapporter, mais une cause, sinon
    // l'opérateur ne peut pas distinguer « rien écouté » de « refusé ».
    const resultat = await checkGateway("http://127.0.0.1:1", DELAI_TEST_MS);

    expect(resultat.ok).toBe(false);
    expect(resultat.latencyMs).toBeNull();
    expect(resultat.error).toBeTruthy();
  });

  test("corps qui ne se termine jamais : échec borné, pas un blocage", async () => {
    // En-têtes 200 puis plus rien. Le piège : conclure « vivante » sur la seule
    // ligne de statut, ou pire, attendre indéfiniment un corps que la sonde ne
    // lit même pas. La seule garantie qui compte ici est temporelle — le cycle
    // de statut doit repartir.
    const serveur = serveurJetable(
      () => new Response(new ReadableStream({ start() { /* jamais fermé */ } })),
    );
    try {
      const debut = Date.now();
      const resultat = await checkGateway(serveur.url, DELAI_TEST_MS);
      const ecoule = Date.now() - debut;

      expect(resultat.ok).toBe(false);
      expect(resultat.error).toBeTruthy();
      expect(ecoule).toBeLessThan(DELAI_TEST_MS * 8);
    } finally {
      serveur.stop();
    }
  });

  test("la sonde de vivacité vise /health et rien d'autre", async () => {
    // Les deux sondes ne construisent pas leur URL de la même façon : celle
    // d'Ollama suffixe l'URL configurée, celle de la gateway vise un chemin
    // absolu. Ce test fige ce que chacune demande réellement — une URL de
    // sonde qui dérive sonderait un endpoint qui n'existe pas et déclarerait
    // la dépendance morte alors qu'elle va bien.
    const chemins: string[] = [];
    await avecServeur(
      (req) => {
        chemins.push(new URL(req.url).pathname);
        return Response.json({ models: [] });
      },
      async (url) => {
        await checkGateway(url);
        await checkOllama(url, MODELE_REPLI);
      },
    );

    expect(chemins).toEqual(["/health", "/api/tags"]);
  });
});
