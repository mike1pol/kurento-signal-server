const kurento = require('kurento-client');

function CallMediaPipeline(kurentoClient, candidatesQueue, send) {
  this.kurentoClient = kurentoClient;
  this.candidatesQueue = candidatesQueue;
  this.send = send;
  this.pipeline = null;
  this.webRtcEndpoint = {};
}

CallMediaPipeline.prototype.createPipeline = function (to, from) {
  return new Promise((resolve, reject) => {
    if (!this.kurentoClient) {
      return reject('kurento server not found');
    }
    return this.kurentoClient.create('MediaPipeline', (error, pipeline) => {
      if (error) {
        if (pipeline) {
          pipeline.release();
        }
        console.error(error);
        return reject(error);
      }
      return pipeline.create('WebRtcEndpoint', (errorE, toWebRtcEndpoint) => {
        if (errorE) {
          if (pipeline) {
            pipeline.release();
          }
          console.error(errorE);
          reject(errorE);
          return;
        }
        if (this.candidatesQueue[to.id]) {
          while (this.candidatesQueue[to.id].length) {
            const candidate = this.candidatesQueue[to.id].shift();
            if (candidate) {
              toWebRtcEndpoint.addIceCandidate(candidate);
            }
          }
        }

        toWebRtcEndpoint.on('OnIceCandidate', (event) => {
          const candidate = kurento.getComplexType('IceCandidate')(event.candidate);
          this.send(to.ws, {id: 'iceCandidate', candidate});
        });

        pipeline.create('WebRtcEndpoint', (errorE2, fromWebRtcEndpoint) => {
          if (errorE2) {
            if (pipeline) {
              pipeline.release();
            }
            console.error(errorE2);
            reject(errorE2);
            return;
          }
          if (this.candidatesQueue[from.id]) {
            while (this.candidatesQueue[from.id].length) {
              const candidate = this.candidatesQueue[from.id].shift();
              if (candidate) {
                fromWebRtcEndpoint.addIceCandidate(candidate);
              }
            }
          }

          fromWebRtcEndpoint.on('OnIceCandidate', (event) => {
            const candidate = kurento.getComplexType('IceCandidate')(event.candidate);
            this.send(from.ws, {id: 'iceCandidate', candidate});
          });

          toWebRtcEndpoint.connect(fromWebRtcEndpoint, (error2) => {
            if (error2) {
              if (pipeline) {
                pipeline.release();
              }
              console.error(error2);
              reject(error2);
              return;
            }
            fromWebRtcEndpoint.connect(toWebRtcEndpoint, (error3) => {
              if (error3) {
                if (pipeline) {
                  pipeline.release();
                }
                console.error(error3);
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

CallMediaPipeline.prototype.generateSdpAnswer = function (id, sdpOffer, callback) {
  this.webRtcEndpoint[id].processOffer(sdpOffer, callback);
  this.webRtcEndpoint[id].gatherCandidates((error) => {
    if (error) {
      callback(error);
    }
  });
};

CallMediaPipeline.prototype.release = function () {
  if (this.pipeline) this.pipeline.release();
  this.pipeline = null;
};

module.exports = CallMediaPipeline;
