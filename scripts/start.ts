// Keep the built client and API on one loopback origin. This is a local release,
// not a public service that borrows the publisher's credentials.
process.env.SCC_SERVE_DIST = '1';
await import('../server/index.ts');
export {};
