const express = require('express');
const wsServer = require('ws');
const kurento = require('kurento-client');
const http = require('http');

const app = express();
const port = process.env.NODE_PORT || 3000;
const kurentoWs = process.env.NODE_KURENTO || 'wss://localhost/kurento';
/*
 * Definition of global variables.
 */
let idCounter = 0;
let kurentoClient = null;
let users = [];
const pipelines = {};
const candidatesQueue = {};

kurento(kurentoWs, (error, _kurentoClient) => {
  if (error) {
    throw new Error(`Not find media server at address ${kurentoWs}`, error);
  }
  kurentoClient = _kurentoClient;
});


function nextUniqueId() {
  idCounter = (idCounter + 1);
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
        incomingCallResponse(sessionId, message.to, message.response, message.sdpOffer, ws);
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

function onError(ws, id, message) {
  ws.send(JSON.stringify({id, response: 'rejected', message}));
}

function send(ws, message) {
  ws.send(JSON.stringify(message));
}

function unRegister(id) {
  users = users.filter(v => v.id !== id);
}

function register(id, userId, name, ws) {
  if (users.find(v => v.userId === userId && +v.id === +id)) {
    return onError(ws, 'registerResponse', `User ${name} already registred for session ${id}`);
  }
  users.push({
    id,
    userId,
    name,
    ws,
  });
  return send(ws, {id: 'registerResponse', response: 'accepted'});
}

function call(id, toId, sdpOffer, ws) {
  clearCandidatesQueue(id);
  const from = users.find(v => +v.id === +id);
  from.sdpOffer = sdpOffer;
  const to = users.filter(v => v.userId === toId) || [];
  if (to.length === 0) {
    return onError(ws, 'callResponse', `User ${to} is not registred`);
  }
  from.peer = to.id;
  to.peer = from.id;
  const message = {
    id: 'incomingCall',
    from: from.name,
    sessionId: id,
  };
  return to.forEach((s) => {
    send(s.ws, message);
  });
}

function CallMediaPipeline() {
  this.pipeline = null;
  this.webRtcEndpoint = {};
}

CallMediaPipeline.prototype.createPipeline = function(to, from) {
  return new Promise((resolve, reject) => {
    if (!kurentoClient) {
      return reject('kurento server not found');
    }
    return kurentoClient.create('MediaPipeline', (error, pipeline) => {
      if (error) {
        pipeline.release();
        return reject(error);
      }
      return pipeline.create('WebRtcEndpoint', (errorE, toWebRtcEndpoint) => {
        if (errorE) {
          pipeline.release();
          reject(errorE);
          return;
        }
        if (candidatesQueue[to.id]) {
          while (candidatesQueue[to.id].length) {
            const candidate = candidatesQueue[to.id].shift();
            if (candidate) {
              toWebRtcEndpoint.addIceCandidate(candidate);
            }
          }
        }

        toWebRtcEndpoint.on('OnIceCandidate', (event) => {
          const candidate = kurento.getComplexType('IceCandidate')(event.candidate);
          send(to.ws, {id: 'iceCandidate', candidate});
        });

        pipeline.create('WebRtcEndpoint', (errorE2, fromWebRtcEndpoint) => {
          if (errorE2) {
            pipeline.release();
            reject(errorE2);
            return;
          }
          if (candidatesQueue[from.id]) {
            while (candidatesQueue[from.id].length) {
              const candidate = candidatesQueue[from.id].shift();
              if (candidate) {
                fromWebRtcEndpoint.addIceCandidate(candidate);
              }
            }
          }

          fromWebRtcEndpoint.on('OnIceCandidate', (event) => {
            const candidate = kurento.getComplexType('IceCandidate')(event.candidate);
            send(from.ws, {id: 'iceCandidate', candidate});
          });

          toWebRtcEndpoint.connect(fromWebRtcEndpoint, (error2) => {
            if (error2) {
              pipeline.release();
              reject(error2);
              return;
            }
            fromWebRtcEndpoint.connect(toWebRtcEndpoint, (error3) => {
              if (error3) {
                pipeline.release();
                reject(error3);
                return;
              }
              this.pipeline = pipeline;
              this.webRtcEndpoint[from.id] = fromWebRtcEndpoint;
              this.webRtcEndpoint[to.id] = toWebRtcEndpoint;
              resolve(null);
            });
          });
        });
      });
    });
  });
};

CallMediaPipeline.prototype.generateSdpAnswer = function(id, sdpOffer, callback) {
  this.webRtcEndpoint[id].processOffer(sdpOffer, callback);
  this.webRtcEndpoint[id].gatherCandidates(function(error) {
    if (error) {
      callback(error);
    }
  });
};

CallMediaPipeline.prototype.release = function() {
  if (this.pipeline) this.pipeline.release();
  this.pipeline = null;
};

function incomingCallResponse(id, toId, response, sdpOffer, ws) {
  clearCandidatesQueue(id);
  const user = users.find(v => +v.id === +id);
  user.sdpOffer = sdpOffer;
  const to = users.find(v => +v.id === +toId);
  if (!to) {
    return onError(ws, 'Call not found');
  }
  if (response === 'accept') {
    const pipeline = new CallMediaPipeline();
    pipelines[user.id] = pipeline;
    pipelines[to.id] = pipeline;
    return pipeline.createPipeline(to, user)
      .then(() => {
        pipeline.generateSdpAnswer(to.id, to.sdpOffer, (error, toSdpAnswer) => {
          if (error) {
            throw error;
          }
          pipeline.generateSdpAnswer(user.id, user.sdpOffer, (error2, fromSdpAnswer) => {
            if (error2) {
              throw error2;
            }
            send(user.ws, {id: 'startCommunication', sdpOffer: fromSdpAnswer});
            send(to.ws, {id: 'callResponse', response: 'accepted', sdpOffer: toSdpAnswer});
          });
        });
      })
      .catch((error) => {
        if (pipeline) {
          pipeline.release();
        }
        onError(user.ws, 'callResponse', error);
        onError(to.ws, 'callResponse', error);
      });
  }
  return send(to.ws, {id: 'callResponse', response: 'rejected', message: 'user declined'});
}

function clearCandidatesQueue(sessionId) {
  if (candidatesQueue[sessionId]) {
    delete candidatesQueue[sessionId];
  }
}

function stop(sessionId) {
  if (!pipelines[sessionId]) {
    return;
  }

  const pipeline = pipelines[sessionId];
  delete pipelines[sessionId];
  pipeline.release();
  const stopperUser = users.find(v => +v.id === +sessionId);
  const stoppedUser = users.find(v => +v.id === +stopperUser.peer);
  stopperUser.peer = null;

  if (stoppedUser) {
    stoppedUser.peer = null;
    delete pipelines[stoppedUser.id];
    const message = {
      id: 'stopCommunication',
      message: 'remote user hanged out',
    };
    send(stoppedUser.ws, message);
  }

  clearCandidatesQueue(sessionId);
}

function onIceCandidate(sessionId, _candidate) {
  const candidate = kurento.getComplexType('IceCandidate')(_candidate);

  if (pipelines[sessionId] && pipelines[sessionId].webRtcEndpoint && pipelines[sessionId].webRtcEndpoint[sessionId]) {
    const webRtcEndpoint = pipelines[sessionId].webRtcEndpoint[sessionId];
    webRtcEndpoint.addIceCandidate(candidate);
  } else {
    if (!candidatesQueue[sessionId]) {
      candidatesQueue[sessionId] = [];
    }
    candidatesQueue[sessionId].push(candidate);
  }
}
