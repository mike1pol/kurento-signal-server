const kurento = require('kurento-client');

const CallMediaPipeline = require('./callMediaPipeline');

const kurentoWs = process.env.NODE_KURENTO || 'wss://localhost/kurento';

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


function onError(ws, id, message) {
  ws.send(JSON.stringify({id, response: 'rejected', message}));
}

function send(ws, message) {
  ws.send(JSON.stringify(message));
}

function register(id, userId, name, ws) {
  if (users.find(v => v.userId === userId && +v.id === +id)) {
    return onError(ws, 'registerResponse', `User ${name} already registred for this session`);
  }
  users.push({
    id,
    userId,
    name,
    ws,
  });
  return send(ws, {id: 'registerResponse', response: 'accepted'});
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

function unRegister(id) {
  users = users.filter(v => v.id !== id);
}

function call(id, toId, sdpOffer, ws) {
  clearCandidatesQueue(id);
  const from = users.find(v => +v.id === +id);
  if (!from) {
    return onError(ws, 'callResponse', 'User not found');
  }
  from.sdpOffer = sdpOffer;
  const to = users.filter(v => v.userId === toId) || [];
  if (to.length === 0) {
    return onError(ws, 'callResponse', 'User is offline');
  }
  const message = {
    id: 'incomingCall',
    from: from.name,
    sessionId: id,
  };
  return to.forEach((s) => {
    send(s.ws, message);
  });
}

function incomingCallResponse(id, toId, response, message, sdpOffer, ws) {
  clearCandidatesQueue(id);
  const user = users.find(v => +v.id === +id);
  user.sdpOffer = sdpOffer;
  const to = users.find(v => +v.id === +toId);
  if (!to) {
    return onError(ws, 'incomingCallResponse', 'Call not found');
  }
  user.peer = to.id;
  to.peer = user.id;
  if (response === 'accept') {
    const pipeline = new CallMediaPipeline(kurentoClient, candidatesQueue, send);
    pipelines[user.id] = pipeline;
    pipelines[to.id] = pipeline;
    return pipeline.createPipeline(to, user)
      .then(() => {
        pipeline.generateSdpAnswer(to.id, to.sdpOffer, (error, toSdpAnswer) => {
          if (error) {
            console.error(error);
            throw error;
          }
          pipeline.generateSdpAnswer(user.id, user.sdpOffer, (error2, fromSdpAnswer) => {
            if (error2) {
              console.error(error2);
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
  return send(to.ws, {id: 'callResponse', response: 'rejected', message: message || 'User declined'});
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

module.exports = {
  onError,
  send,
  register,
  stop,
  clearCandidatesQueue,
  unRegister,
  call,
  incomingCallResponse,
  onIceCandidate,
};
