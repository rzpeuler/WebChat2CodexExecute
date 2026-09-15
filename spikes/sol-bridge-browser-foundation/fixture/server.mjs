import { createServer } from 'node:http';

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sol Bridge fixture</title></head>
<body>
<main data-project-id="fixture-project" data-account-id="fixture-account">
<section id="messages">
  <article data-message-author-role="user">fixture user message</article>
  <article data-message-author-role="assistant">fixture assistant message</article>
</section>
<div id="thinking" hidden>Thinking...</div>
<textarea id="prompt" aria-label="Message"></textarea>
<button id="send" type="button">Send</button>
<output id="send-status"></output>
</main>
<script>
const messages = document.querySelector('#messages');
const thinking = document.querySelector('#thinking');
const prompt = document.querySelector('#prompt');
const status = document.querySelector('#send-status');
document.querySelector('#send').addEventListener('click', () => {
  const value = prompt.value.trim();
  if (!value) return;
  const user = document.createElement('article');
  user.dataset.messageAuthorRole = 'user';
  user.textContent = value;
  messages.append(user);
  prompt.value = '';
  thinking.hidden = false;
  status.textContent = 'submitted';
  setTimeout(() => { thinking.hidden = true; status.textContent = 'confirmed'; }, 30);
});
</script></body></html>`;

export function startFixtureServer() {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/c/')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(page);
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('fixture server did not expose a port'));
      resolve({ server, port: address.port, url: `http://127.0.0.1:${address.port}/c/fixture-1` });
    });
  });
}

