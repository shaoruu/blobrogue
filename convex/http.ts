import { httpRouter } from "convex/server";
import { auth } from "./auth";

// Convex Auth mounts its OAuth routes (sign-in redirect + provider callback) under
// /api/auth on the deployment's .convex.site domain. The Google "Authorized redirect
// URI" the operator adds in Google Cloud Console is:
//   https://<deployment>.convex.site/api/auth/callback/google
// See AUTH_SETUP.md.
const http = httpRouter();

auth.addHttpRoutes(http);

export default http;
