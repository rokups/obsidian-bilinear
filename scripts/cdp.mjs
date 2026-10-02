// A minimal Chrome DevTools Protocol client for driving a running Obsidian
// (started with --remote-debugging-port). Needs Node 22 for WebSocket.

export async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((t) => t.type === "page" && t.url.includes("index.html")) ?? targets.find((t) => t.type === "page");
  if (!target) throw new Error(`no Obsidian window on port ${port}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("cannot connect to Obsidian"));
  });
  let next = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const waiting = pending.get(msg.id);
    if (!waiting) return;
    pending.delete(msg.id);
    if (msg.error) waiting.reject(new Error(msg.error.message));
    else waiting.resolve(msg.result);
  };
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      pending.set(next, { resolve, reject });
      ws.send(JSON.stringify({ id: next++, method, params }));
    });
  return {
    /** Run fn(...args) in the Obsidian window and return its (awaited, JSON) result. */
    async run(fn, ...args) {
      const expression = `(${fn})(...${JSON.stringify(args)})`;
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    close: () => ws.close(),
  };
}
