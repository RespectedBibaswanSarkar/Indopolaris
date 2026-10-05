import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces .next/standalone with a minimal server bundle — the Dockerfile
  // relies on this.
  output: "standalone",

  // `minio` and `pg` are CommonJS packages that pull in optional native
  // dependencies. Letting the server bundle them breaks the optional-require
  // probing they do at load time, so they are required from node_modules.
  serverExternalPackages: ["minio", "pg", "@prisma/adapter-pg", "bcryptjs"],

  // The generated Prisma client (src/generated/prisma) is TypeScript source
  // emitted by the `prisma-client` generator. It lives under src/, so Next
  // compiles it like any other project file — no transpilePackages entry needed.
  //
  // There is deliberately no `eslint` key: Next 16 removed it, along with
  // linting from `next build`. Linting is an explicit `npm run lint` step.
  //
  // There is also no `webpack` key. Next 16 builds with Turbopack by default
  // and rejects a webpack config outright; `serverExternalPackages` above is
  // the bundler-agnostic way to keep these packages external, so the old
  // `config.externals.push("pg-native")` workaround is not needed.
};

export default nextConfig;
