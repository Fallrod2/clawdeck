// src/network-diagnosis.ts — la CONCLUSION tirée des trois sondes ICMP.
//
// Raison d'être : une coupure d'accès opérateur et une panne de réseau local
// produisaient le même affichage — des pastilles rouges alignées — alors que
// ce sont deux diagnostics opposés, et que c'est précisément la question qu'on
// vient poser à ce dashboard. Les sondes existaient déjà ; ce qui manquait,
// c'est ce que leur combinaison permet — ou interdit — d'affirmer.
//
// Le raisonnement tient en deux axes. La passerelle locale prouve l'état du
// LAN et du lien du Mac mini. Les deux témoins externes, indépendants l'un de
// l'autre (résolveur anycast et IP fixe française), prouvent qu'un paquet sort
// et revient : dès qu'UN seul répond, l'accès fonctionne, quoi que dise la
// sonde de passerelle.
//
// Ce que ce module refuse d'affirmer, faute de données qui le soutiennent :
//   - « panne FAI » — depuis le Mac mini, un lien WAN mort dans la box et une
//     panne opérateur sont indiscernables ; on dit « en amont de la
//     passerelle » et on nomme les deux hypothèses ;
//   - quoi que ce soit sur l'amont quand la sonde la plus proche est déjà
//     muette : une coupure locale masque tout ce qui est derrière elle ;
//   - « Internet fonctionne » au sens applicatif — ces sondes ne prouvent
//     qu'un écho ICMP, jamais le DNS, le TLS, le HTTP ni le débit.

export type NetworkVerdict =
  /** Les trois sondes répondent. */
  | "operational"
  /** Le trafic sort, mais une destination externe reste muette. */
  | "external-partial"
  /** La passerelle répond, plus rien ne sort : rupture au-delà d'elle. */
  | "upstream-outage"
  /** L'externe répond alors que la passerelle sondée non : c'est la sonde
   *  qui est douteuse, pas le réseau local. */
  | "gateway-probe-suspect"
  /** Rien ne répond, à commencer par le plus proche : amont indéterminable. */
  | "blackout";

export type NetworkSeverity = "good" | "warning" | "critical";

export interface NetworkProbeSample {
  ok: boolean;
  host: string;
}

export interface NetworkProbes {
  /** Passerelle par défaut du LAN : témoin du lien local. */
  local: NetworkProbeSample;
  /** Résolveur public : premier témoin externe. */
  internet: NetworkProbeSample;
  /** Site distant supervisé : second témoin externe, autre chemin. */
  remote: NetworkProbeSample;
}

export interface NetworkDiagnosis {
  verdict: NetworkVerdict;
  severity: NetworkSeverity;
  /** Conclusion en une ligne, telle qu'elle s'affiche. */
  headline: string;
  /** Ce que les mesures soutiennent, et ce qu'elles ne soutiennent pas. */
  detail: string;
  /** Hôtes muets sur cette mesure, pour les nommer sans les deviner. */
  silentHosts: string[];
}

const LOCAL_LABEL = "la passerelle locale";
const INTERNET_LABEL = "Internet";
const REMOTE_LABEL = "le site distant";

function joinFr(labels: string[]): string {
  if (labels.length < 2) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} et ${labels.at(-1)}`;
}

function conjugate(labels: string[]): string {
  return labels.length > 1 ? "répondent" : "répond";
}

/**
 * Verdict réseau à partir d'une mesure complète. Fonction totale et pure :
 * cinq cas couvrent les huit combinaisons possibles des trois sondes.
 *
 * La fraîcheur de la mesure n'entre PAS ici : ce module conclut sur ce qui
 * vient d'être observé, c'est à l'affichage de suspendre la conclusion quand
 * le flux de statut a vieilli (App.tsx).
 */
export function diagnoseNetwork(probes: NetworkProbes): NetworkDiagnosis {
  const { local, internet, remote } = probes;

  const silentHosts = [
    ...(local.ok ? [] : [local.host]),
    ...(internet.ok ? [] : [internet.host]),
    ...(remote.ok ? [] : [remote.host]),
  ];
  const externalUp = [
    ...(internet.ok ? [INTERNET_LABEL] : []),
    ...(remote.ok ? [REMOTE_LABEL] : []),
  ];
  const externalDown = [
    ...(internet.ok ? [] : [INTERNET_LABEL]),
    ...(remote.ok ? [] : [REMOTE_LABEL]),
  ];

  if (local.ok && externalDown.length === 0) {
    return {
      verdict: "operational",
      severity: "good",
      headline: "Liaison réseau complète",
      detail: `La passerelle locale (${local.host}), ${INTERNET_LABEL} et ${REMOTE_LABEL} répondent.`,
      silentHosts,
    };
  }

  if (local.ok && externalUp.length > 0) {
    return {
      verdict: "external-partial",
      severity: "warning",
      headline: "Accès externe partiel",
      detail:
        `Le trafic sort bien du réseau local : ${joinFr([`la passerelle locale (${local.host})`, ...externalUp])} répondent. ` +
        `Seul ${joinFr(externalDown)} reste muet — la cause est à cette destination ` +
        "ou sur le chemin qui y mène, pas sur l'accès local.",
      silentHosts,
    };
  }

  if (local.ok) {
    return {
      verdict: "upstream-outage",
      severity: "critical",
      headline: "Coupure en amont de la passerelle locale",
      detail:
        `La passerelle locale (${local.host}) répond, aucune destination externe ne répond : ` +
        "le réseau local fonctionne, la rupture est au-delà — lien WAN de la box " +
        "ou accès opérateur. Ces sondes ne permettent pas de trancher entre les deux.",
      silentHosts,
    };
  }

  if (externalUp.length > 0) {
    return {
      verdict: "gateway-probe-suspect",
      severity: "warning",
      headline: "Passerelle locale muette, accès externe fonctionnel",
      detail:
        `${joinFr(externalUp)} ${conjugate(externalUp)} : le trafic sort donc bien par une passerelle. ` +
        `L'adresse sondée (${local.host}) n'est probablement plus la route par défaut, ` +
        "ou elle ignore les pings — rien ici n'indique une panne du réseau local.",
      silentHosts,
    };
  }

  return {
    verdict: "blackout",
    severity: "critical",
    headline: "Aucune sonde réseau ne répond",
    detail:
      `Rien ne répond, pas même ${LOCAL_LABEL} (${local.host}). La coupure est au plus ` +
      "près — lien réseau du Mac mini ou passerelle — et masque tout ce qui est " +
      "derrière elle : l'état de l'accès opérateur reste indéterminé.",
    silentHosts,
  };
}
