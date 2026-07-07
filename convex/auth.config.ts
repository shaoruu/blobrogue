// Tells Convex which JWT issuer to trust for authenticated function calls. For
// Convex Auth the issuer is the deployment's own site URL; `applicationID` must be
// "convex". CONVEX_SITE_URL is injected automatically by the Convex runtime.
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
