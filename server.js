const express = require('express');
const wsServer = require('ws');
const http = require('http');

const {
  register,
  stop,
  unRegister,
  call,
  incomingCallResponse,
  onIceCandidate,
} = require('./kurento');

const app = express();
const port = process.env.NODE_PORT || 3000;
/*
 * Definition of global variables.
 */
let idCounter = 0;

function nextUniqueId() {
  idCounter += 1;
  return idCounter.toString();
}

const server = http.createServer(app);

server.listen(port, () => {
  console.log(`Signal server started at port http://localhost:${port}`);
});

const wss = new wsServer.Server({
  server,
  path: '/call',
});

wss.on('connection', (ws) => {
  const sessionId = nextUniqueId();
  console.log(`Connection received with sessionId: ${sessionId}`);

  ws.on('error', (error) => {
    console.log(`Connection ${sessionId} error`);
    console.error(error);
  });

  ws.on('close', () => {
    console.log(`Connection ${sessionId} closed`);
    stop(sessionId);
    unRegister(sessionId);
  });

  ws.on('message', (_message) => {
    const message = JSON.parse(_message);
    console.log(`Connection ${sessionId} received message `, message);
    switch (message.id) {
      case 'register':
        register(sessionId, message.userId, message.name, ws);
        break;
      case 'unregister':
        unRegister(sessionId);
        break;
      case 'call':
        call(sessionId, message.to, message.sdpOffer, ws);
        break;
      case 'incomingCallResponse':
        incomingCallResponse(sessionId, message.to, message.response, message.message, message.sdpOffer, ws);
        break;
      case 'stop':
        stop(sessionId);
        break;
      case 'onIceCandidate':
        onIceCandidate(sessionId, message.candidate);
        break;
      default:
        ws.send(JSON.stringify({
          id: 'error',
          message: `Invalid message ${message}`,
        }));
        break;
    }
  });
});
