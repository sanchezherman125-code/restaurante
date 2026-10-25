/** Token con la forma de un JWT (sin firma válida): basta para identificar al usuario local en pruebas. */
export function fakeJwt(sub: string): string {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "HS256" })}.${encode({ sub, type: "access" })}.firma`;
}
