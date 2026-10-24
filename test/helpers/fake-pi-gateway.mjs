/**
 * Local fake pi-ai gateway for the integration test.
 *
 * The real `@deepseek-ai/dsh-llm-pi-ai` adapter is mounted against this server;
 * it records every raw HTTP request body so a test can assert on the exact
 * wire payload the adapter would have sent. The POST `/v1/responses` reply is
 * the minimum OpenAI Responses SSE sequence `processResponsesStream()` accepts
 * (see `@earendil-works/pi-ai/dist/api/openai-responses-shared.js`):
 *
 *   response.created
 *   response.output_item.added      (item.type = 'message')
 *   response.output_text.delta
 *   response.output_item.done       (item.content = [{type:'output_text'}])
 *   response.completed              (response.status = 'completed', usage)
 *
 * Every other path (notably `GET /v1/models` for discovery) is answered
 * defensively with a small JSON document, so no request can hang.
 */
import http from 'node:http';

/** Build the terminal SSE body once; the JSON event names are pi-ai's wire contract. */
function successSseBody() {
  const message = {
    type: 'message',
    id: 'msg_fake_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'ok', annotations: [] }],
  };
  const events = [
    { type: 'response.created', response: { id: 'resp_fake_1', status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_fake_1', role: 'assistant', status: 'in_progress', content: [] },
    },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_fake_1', content_index: 0, delta: 'ok' },
    { type: 'response.output_item.done', output_index: 0, item: message },
    {
      type: 'response.completed',
      response: {
        id: 'resp_fake_1',
        status: 'completed',
        output: [message],
        usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 },
      },
    },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

const SUCCESS_SSE = successSseBody();

/**
 * Start the recording stub on an ephemeral loopback port.
 *
 * @returns {Promise<{
 *   port: number,
 *   baseURL: string,
 *   requests: Array<{method: string, url: string, headers: Record<string, string|string[]|undefined>, rawBody: Buffer, body: unknown}>,
 *   close: () => Promise<void>,
 * }>} the live gateway.
 */
export async function startFakePiGateway() {
  /** @type {Array<{method: string, url: string, headers: Record<string, string|string[]|undefined>, rawBody: Buffer, body: unknown}>} */
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      let body;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        body = undefined;
      }
      requests.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, rawBody, body });

      if (request.method === 'POST' && /\/responses\/?(?:\?.*)?$/.test(request.url ?? '')) {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        response.end(SUCCESS_SSE);
        return;
      }
      if (request.method === 'GET' && /\/models(?:\?.*)?$/.test(request.url ?? '')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'test-model', object: 'model', created: 0, owned_by: 'fake-gateway' }],
          }),
        );
        return;
      }
      // Discovery probes and anything else the adapter might ask for: answer
      // with valid empty JSON instead of a 404 so no request path can hang.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [] }));
    });
    request.on('error', () => {
      // The adapter may abort a stream; the recorded body is what matters.
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake gateway did not bind a TCP port');

  return {
    port: address.port,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      }),
  };
}

const IMAGE_DATA_URI = /data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/gi;

/**
 * Extract every inline image payload from one recorded request body.
 *
 * The adapter inlines images as `data:<media>;base64,<payload>` strings, and
 * the base64 payload length is exactly what `requiredImageOffload()` and the
 * guard's own byte accounting sum.
 *
 * @param {unknown} body - parsed request JSON, raw body text, or anything JSON-serializable.
 * @returns {string[]} base64 payloads in request order.
 */
export function imageDataUris(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const payloads = [];
  const pattern = new RegExp(IMAGE_DATA_URI.source, 'gi');
  let match;
  while ((match = pattern.exec(text)) !== null) payloads.push(match[1]);
  return payloads;
}

/**
 * Measure the inline image payload of one request body.
 * @param {unknown} body - parsed request JSON or raw body text.
 * @returns {{ count: number, base64Bytes: number }} occurrence count and summed base64 length.
 */
export function imagePayloadStats(body) {
  const payloads = imageDataUris(body);
  return {
    count: payloads.length,
    base64Bytes: payloads.reduce((sum, payload) => sum + payload.length, 0),
  };
}

/** Visit every string leaf of a JSON value. */
function visitStrings(value, visit) {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitStrings(item, visit);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) visitStrings(item, visit);
  }
}

/**
 * Classify the image occurrences one request body renders.
 *
 * A retained occurrence carries the request-image handle
 * (`Image "<name>" (sha256:…); request preview WxHpx.`); an offloaded one
 * carries `[image omitted to fit request image limits; "<name>" …]`. Names are
 * unique in the scenario, so they key the two maps.
 *
 * @param {unknown} body - parsed request JSON.
 * @returns {{ retained: Map<string, string>, offloaded: Map<string, string> }} handle text by image name.
 */
export function classifyImageHandles(body) {
  const retained = new Map();
  const offloaded = new Map();
  visitStrings(body, (text) => {
    const kept = /(?:^|\n)Image "([^"]+)"/.exec(text);
    if (kept !== null) retained.set(kept[1], text);
    const omitted = /image omitted to fit request image limits; "([^"]+)"/.exec(text);
    if (omitted !== null) offloaded.set(omitted[1], text);
  });
  return { retained, offloaded };
}

/**
 * Index of the first model input that renders an offload placeholder.
 * @param {unknown} body - parsed request JSON.
 * @returns {number} zero-based input index, or -1 when nothing was offloaded.
 */
export function firstOffloadIndex(body) {
  const input = body?.input;
  if (!Array.isArray(input)) return -1;
  return input.findIndex((item) => JSON.stringify(item).includes('image omitted to fit request image limits'));
}
