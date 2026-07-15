const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  let filePath = '.' + req.url;
  if (filePath == './') filePath = './index.html';
  const extname = path.extname(filePath);
  const contentType = extname === '.js' ? 'text/javascript' : extname === '.css' ? 'text/css' : 'text/html';
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(500); res.end(); }
    else { res.writeHead(200, { 'Content-Type': contentType }); res.end(content, 'utf-8'); }
  });
});
server.listen(8124);

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page1 = await browser.newPage();
  const page2 = await browser.newPage();

  page1.on('console', msg => console.log('PAGE 1:', msg.text()));
  page2.on('console', msg => console.log('PAGE 2:', msg.text()));

  await page1.goto('http://127.0.0.1:8124');
  await page2.goto('http://127.0.0.1:8124');

  await new Promise(r => setTimeout(r, 4000));

  await page1.type('#chat-input', 'Hello from page 1!');
  await page1.click('#btn-chat-send');

  await new Promise(r => setTimeout(r, 2000));

  const chatText = await page2.evaluate(() => document.getElementById('chat-history').innerText);
  console.log("Chat history on Page 2:\n" + chatText);

  await browser.close();
  server.close();
})();
