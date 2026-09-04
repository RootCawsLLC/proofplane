/** @type {import('next').NextConfig} */
const nextConfig = {
  // The proofplane tool is never imported into the web bundle. The assurance run
  // happens in a separate Node process (scripts/run-assure.mjs) that boots the
  // real target server and spawns the real Python probe CLI against it, so there
  // is nothing here to externalize.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
