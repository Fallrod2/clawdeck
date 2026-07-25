import { describe, expect, test } from "bun:test";
import { diagnoseNetwork, type NetworkProbes } from "./network-diagnosis";

const LOCAL = "192.168.1.1";
const INTERNET = "1.1.1.1";
const REMOTE = "83.204.110.38";

function probes(local: boolean, internet: boolean, remote: boolean): NetworkProbes {
  return {
    local: { host: LOCAL, ok: local },
    internet: { host: INTERNET, ok: internet },
    remote: { host: REMOTE, ok: remote },
  };
}

describe("diagnoseNetwork", () => {
  test("les trois sondes répondent : liaison complète", () => {
    const diagnosis = diagnoseNetwork(probes(true, true, true));
    expect(diagnosis.verdict).toBe("operational");
    expect(diagnosis.severity).toBe("good");
    expect(diagnosis.silentHosts).toEqual([]);
  });

  test("passerelle seule joignable : coupure en amont, sans nommer de coupable", () => {
    const diagnosis = diagnoseNetwork(probes(true, false, false));
    expect(diagnosis.verdict).toBe("upstream-outage");
    expect(diagnosis.severity).toBe("critical");
    expect(diagnosis.silentHosts).toEqual([INTERNET, REMOTE]);
    // Les deux hypothèses restent ouvertes : trois pings ne distinguent pas un
    // lien WAN mort d'une panne opérateur.
    expect(diagnosis.detail).toContain("box");
    expect(diagnosis.detail).toContain("opérateur");
    expect(diagnosis.detail).not.toContain("FAI");
  });

  test("site distant seul muet : la cause est à la destination", () => {
    const diagnosis = diagnoseNetwork(probes(true, true, false));
    expect(diagnosis.verdict).toBe("external-partial");
    expect(diagnosis.severity).toBe("warning");
    expect(diagnosis.silentHosts).toEqual([REMOTE]);
    expect(diagnosis.detail).toContain("le site distant");
  });

  test("témoin Internet seul muet : même verdict, autre destination nommée", () => {
    const diagnosis = diagnoseNetwork(probes(true, false, true));
    expect(diagnosis.verdict).toBe("external-partial");
    expect(diagnosis.silentHosts).toEqual([INTERNET]);
    expect(diagnosis.detail).toContain("Seul Internet");
  });

  test("externe joignable mais passerelle muette : c'est la sonde qui est douteuse", () => {
    const diagnosis = diagnoseNetwork(probes(false, true, true));
    expect(diagnosis.verdict).toBe("gateway-probe-suspect");
    expect(diagnosis.severity).toBe("warning");
    expect(diagnosis.silentHosts).toEqual([LOCAL]);
    // Le verdict pointe l'adresse sondée, jamais une panne du réseau local :
    // des paquets sont provablement sortis.
    expect(diagnosis.detail).toContain(LOCAL);
    expect(diagnosis.detail).toContain("route par défaut");
  });

  test("un seul témoin externe suffit à disculper le réseau local", () => {
    expect(diagnoseNetwork(probes(false, true, false)).verdict).toBe("gateway-probe-suspect");
    expect(diagnoseNetwork(probes(false, false, true)).verdict).toBe("gateway-probe-suspect");
  });

  test("plus rien ne répond : l'amont est déclaré indéterminé, pas en panne", () => {
    const diagnosis = diagnoseNetwork(probes(false, false, false));
    expect(diagnosis.verdict).toBe("blackout");
    expect(diagnosis.severity).toBe("critical");
    expect(diagnosis.silentHosts).toEqual([LOCAL, INTERNET, REMOTE]);
    expect(diagnosis.detail).toContain("indéterminé");
    expect(diagnosis.detail).toContain("masque");
    // La sonde la plus proche est déjà muette : rien ne peut être affirmé de
    // l'amont, surtout pas la conclusion inverse (« coupure en amont »).
    expect(diagnosis.detail).not.toContain("en amont");
    expect(diagnosis.headline).not.toContain("amont");
  });

  test("les huit combinaisons produisent un verdict, un libellé et un détail", () => {
    for (const local of [true, false]) {
      for (const internet of [true, false]) {
        for (const remote of [true, false]) {
          const diagnosis = diagnoseNetwork(probes(local, internet, remote));
          expect(diagnosis.headline.length).toBeGreaterThan(0);
          expect(diagnosis.detail.length).toBeGreaterThan(0);
          expect(["good", "warning", "critical"]).toContain(diagnosis.severity);
        }
      }
    }
  });

  test("l'adresse de passerelle affichée est celle réellement sondée", () => {
    const detected = diagnoseNetwork({
      local: { host: "192.168.8.1", ok: true },
      internet: { host: INTERNET, ok: false },
      remote: { host: REMOTE, ok: false },
    });
    expect(detected.detail).toContain("192.168.8.1");
  });

  test("un seul échec externe ne dégrade jamais en critique", () => {
    expect(diagnoseNetwork(probes(true, true, false)).severity).toBe("warning");
    expect(diagnoseNetwork(probes(true, false, true)).severity).toBe("warning");
  });
});
