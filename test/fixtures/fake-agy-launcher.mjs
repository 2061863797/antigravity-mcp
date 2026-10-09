process.argv = [process.execPath, new URL('./fake-agy.mjs', import.meta.url).pathname,
  ...process.argv.slice(2).map(value => Buffer.from(value, 'base64').toString('utf8'))];
await import('./fake-agy.mjs');
