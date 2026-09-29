// The signed-in subdomain (e.g. "www" for a personal account, an org's subdomain for Udemy
// Business), set once at login and read from several places in engine.js's URL-building. An
// object with a mutable property, not a bare exported variable: a bare `export let subDomain`
// reassigned from app.ts would not reliably reflect across a require()'d copy the way mutating a
// shared object's property does, since that only relies on both sides holding the same object
// reference, not on live-binding semantics that differ between how ESM and the CJS output here
// actually wire reassignment.
export const session = { subDomain: "www" };
