var BarnesHutSolver = require('./components/physics/BarnesHutSolver').default;
var Repulsion = require('./components/physics/RepulsionSolver').default;
var HierarchicalRepulsion = require('./components/physics/HierarchicalRepulsionSolver').default;
var SpringSolver = require('./components/physics/SpringSolver').default;
var HierarchicalSpringSolver = require('./components/physics/HierarchicalSpringSolver').default;
var CentralGravitySolver = require('./components/physics/CentralGravitySolver').default;
var ForceAtlas2BasedRepulsionSolver = require('./components/physics/FA2BasedRepulsionSolver').default;
var ForceAtlas2BasedCentralGravitySolver = require('./components/physics/FA2BasedCentralGravitySolver').default;
import PhysicsBase                          from './PhysicsBase';
import PhysicsWorker                        from 'worker!./PhysicsWorkerWrapper';

var util = require('../../util');


class PhysicsEngine extends PhysicsBase {
  constructor(body) {
    super();
    this.body = body;

    this.physicsEnabled = true;
    this.simulationInterval = 1000 / 60;
    this.requiresTimeout = true;
    this.freezeCache = {};
    this.renderTimer = undefined;

    this.ready = false; // will be set to true if the stabilize

    // default options
    this.defaultOptions = {
      enabled: true,
      useWorker: false,
      barnesHut: {
        theta: 0.5,
        gravitationalConstant: -2000,
        centralGravity: 0.3,
        springLength: 95,
        springConstant: 0.04,
        damping: 0.09,
        avoidOverlap: 0
      },
      forceAtlas2Based: {
        theta: 0.5,
        gravitationalConstant: -50,
        centralGravity: 0.01,
        springConstant: 0.08,
        springLength: 100,
        damping: 0.4,
        avoidOverlap: 0
      },
      repulsion: {
        centralGravity: 0.2,
        springLength: 200,
        springConstant: 0.05,
        nodeDistance: 100,
        damping: 0.09,
        avoidOverlap: 0
      },
      hierarchicalRepulsion: {
        centralGravity: 0.0,
        springLength: 100,
        springConstant: 0.01,
        nodeDistance: 120,
        damping: 0.09
      },
      maxVelocity: 50,
      minVelocity: 0.75,    // px/s
      solver: 'barnesHut',
      stabilization: {
        enabled: true,
        iterations: 1000,   // maximum number of iteration to stabilize
        updateInterval: 50,
        onlyDynamicEdges: false,
        fit: true
      },
      timestep: 0.5,
      adaptiveTimestep: true
    };
    util.extend(this.options, this.defaultOptions);
    this.layoutFailed = false;
    this.draggingNodes = [];
    this.positionUpdateHandler = () => {};
    this.physicsUpdateHandler = () => {};
    this.emit = this.body.emitter.emit;

    this.bindEventListeners();
  }

  bindEventListeners() {
    this.body.emitter.on('initPhysics',     () => {this.initPhysics();});
    this.body.emitter.on('_layoutFailed',   () => {this.layoutFailed = true;});
    this.body.emitter.on('resetPhysics',    () => {this.stopSimulation(); this.ready = false;});
    this.body.emitter.on('disablePhysics',  () => {this.physicsEnabled = false; this.stopSimulation();});
    this.body.emitter.on('restorePhysics',  () => {
      this.setOptions(this.options);
      if (this.ready === true) {
        this.startSimulation();
      }
    });
    this.body.emitter.on('startSimulation', () => {
      if (this.ready === true) {
        this.startSimulation();
      }
    });
    this.body.emitter.on('stopSimulation',  () => {this.stopSimulation();});
    this.body.emitter.on('destroy',         () => {
      this.stopSimulation(false);
      this.body.emitter.off();
    });
    // this event will trigger a rebuilding of the cache everything. Used when nodes or edges have been added or removed.
    this.body.emitter.on("_dataChanged", () => {
      // update shortcut lists
      this.updatePhysicsData();
    });

    // debug: show forces
    // this.body.emitter.on("afterDrawing", (ctx) => {this._drawForces(ctx);});
    this.body.emitter.on('_positionUpdate',  (properties) => this.positionUpdateHandler(properties));
    this.body.emitter.on('_physicsUpdate',  (properties) => this.physicsUpdateHandler(properties));
    this.body.emitter.on('dragStart', (properties) => {
      this.draggingNodes = properties.nodes;
    });
    this.body.emitter.on('dragEnd', () => {
      this.draggingNodes = [];
    });
    this.body.emitter.on('destroy', () => {
      if (this.physicsWorker) {
        this.physicsWorker.terminate();
        this.physicsWorker = undefined;
      }
    });
  }


  /**
   * set the physics options
   * @param options
   */
  setOptions(options) {
    if (options !== undefined) {
      if (options === false) {
        this.options.enabled = false;
        this.physicsEnabled = false;
        this.stopSimulation();
      }
      else {
        this.physicsEnabled = true;
        util.selectiveNotDeepExtend(['stabilization'], this.options, options);
        util.mergeOptions(this.options, options, 'stabilization');

        if (options.enabled === undefined) {
          this.options.enabled = true;
        }

        if (this.options.enabled === false) {
          this.physicsEnabled = false;
          this.stopSimulation();
        }

        // set the timestep
        this.timestep = this.options.timestep;
      }
    }
    if (this.options.useWorker) {
      this.initPhysicsWorker();
      this.physicsWorker.postMessage({type: 'options', data: this.options});
    } else {
      this.initEmbeddedPhysics();
    }
  }


  /**
   * configure the engine.
   */
  initEmbeddedPhysics() {
    this.positionUpdateHandler = () => {};
    this.physicsUpdateHandler = (properties) => {
      if (properties.options.physics !== undefined) {
        // we've received a node that has changed physics state
        // so rebuild physicsBody
        this.initPhysicsData();
      }
      // else we're accessing the information directly out of the node
      // so no need to do anything.
    };
    if (this.physicsWorker) {
      this.options.useWorker = false;
      this.physicsWorker.terminate();
      this.physicsWorker = undefined;
      this.initPhysicsData();
    }
    this.initPhysicsSolvers();
  }

  initPhysicsWorker() {
    if (!this.physicsWorker) {
      // setup path to webworker javascript file
      if (!__webpack_public_path__) {
        // search for element with id of 'visjs'
        let parentScript = document.getElementById('visjs');
        if (parentScript) {
          let src = parentScript.getAttribute('src')
          __webpack_public_path__ = src.substr(0, src.lastIndexOf('/') + 1);
        } else {
          // search all scripts for 'vis.js'
          let scripts = document.getElementsByTagName('script');
          for (let i = 0; i < scripts.length; i++) {
            let src = scripts[i].getAttribute('src');
            if (src && src.length >= 6) {
              let position = src.length - 6;
              let index = src.indexOf('vis.js', position);
              if (index === position) {
                __webpack_public_path__ = src.substr(0, src.lastIndexOf('/') + 1);
                break;
              }
            }
          }
        }
      }
      // launch webworker
      this.physicsWorker = new PhysicsWorker();
      this.physicsWorker.addEventListener('message', (event) => {
        this.physicsWorkerMessageHandler(event);
      });
      this.physicsWorker.onerror = (event) => {
        console.error('Falling back to embedded physics engine', event);
        this.initEmbeddedPhysics();
        // throw new Error(event.message + " (" + event.filename + ":" + event.lineno + ")");
      };
      this.positionUpdateHandler = (positions) => {
        this.physicsWorker.postMessage({type: 'updatePositions', data: positions});
      };
      this.physicsUpdateHandler = (properties) => {
        this._physicsUpdateHandler(properties);
      };
    }
  }

  _physicsUpdateHandler(properties) {
    if (properties.options.physics !== undefined) {
      if (properties.options.physics) {
        let data = {
          nodes: {},
          edges: {}
        };
        if (properties.type === 'node') {
          data.nodes[properties.id] = this.createPhysicsNode(properties.id);
        } else if (properties.type === 'edge') {
          data.edges[properties.id] = this.createPhysicsEdge(properties.id);
        } else {
          console.warn('invalid element type');
        }
        this.physicsWorker.postMessage({
          type: 'addElements',
          data: data
        });
      } else {
        let data = {
          nodeIds: [],
          edgeIds: []
        };
        if (properties.type === 'node') {
          data.nodeIds = [properties.id.toString()];
        } else if (properties.type === 'edge') {
          data.edgeIds = [properties.id.toString()];
        } else {
          console.warn('invalid element type');
        }
        this.physicsWorker.postMessage({type: 'removeElements', data: data});
      }
    } else {
      this.physicsWorker.postMessage({type: 'updateProperties', data: properties});
    }
  }

  physicsWorkerMessageHandler(event) {
    var msg = event.data;
    switch (msg.type) {
      case 'tickResults':
        this.stabilized = msg.data.stabilized;
        this.stabilizationIterations = msg.data.stabilizationIterations;
        this._receivedPositions(msg.data.positions);
        break;
      case 'finalizeStabilization':
        this._finalizeStabilization();
        break;
      case 'emit':
        this.emit(msg.data.event, msg.data.data);
        break;
      default:
        console.warn('unhandled physics worker message:', msg);
    }
  }

  _receivedPositions(positions) {
    for (let i = 0; i < this.draggingNodes.length; i++) {
      delete positions[this.draggingNodes[i]];
    }
    let nodeIds = Object.keys(positions);
    for (let i = 0; i < nodeIds.length; i++) {
      let nodeId = nodeIds[i];
      let node = this.body.nodes[nodeId];
      // handle case where we get a positions from an old physicsObject
      if (node) {
        node.setX(positions[nodeId].x);
        node.setY(positions[nodeId].y);
      }
    }
  }

  /**
   * initialize the engine
   */
  initPhysics() {
    if (this.physicsEnabled === true && this.options.enabled === true) {
      if (this.options.stabilization.enabled === true) {
        this.stabilize();
      }
      else {
        this.stabilized = false;
        this.ready = true;
        this.body.emitter.emit('fit', {}, this.layoutFailed); // if the layout failed, we use the approximation for the zoom
        this.startSimulation();
      }
    }
    else {
      this.ready = true;
      this.body.emitter.emit('fit');
    }
  }

  /**
   * Start the simulation
   */
  startSimulation() {
    if (this.physicsEnabled === true && this.options.enabled === true) {
      this.stabilized = false;
      this._updateWorkerStabilized();

      // when visible, adaptivity is disabled.
      this.adaptiveTimestep = false;

      // this sets the width of all nodes initially which could be required for the avoidOverlap
      this.body.emitter.emit("_resizeNodes");
      if (this.viewFunction === undefined) {
        this.viewFunction = this.simulationStep.bind(this);
        this.body.emitter.on('initRedraw', this.viewFunction);
        this.body.emitter.emit('_startRendering');
      }
    }
    else {
      this.body.emitter.emit('_redraw');
    }
  }


  /**
   * Stop the simulation, force stabilization.
   */
  stopSimulation(emit = true) {
    this.stabilized = true;
    this._updateWorkerStabilized();

    if (emit === true) {
      this._emitStabilized();
    }
    if (this.viewFunction !== undefined) {
      this.body.emitter.off('initRedraw', this.viewFunction);
      this.viewFunction = undefined;
      if (emit === true) {
        this.body.emitter.emit('_stopRendering');
      }
    }
  }

  _updateWorkerStabilized() {
    if (this.physicsWorker) {
      this.physicsWorker.postMessage({
        type: 'setStabilized',
        data: this.stabilized
      });
    }
  }

  /**
   * The viewFunction inserts this step into each render loop. It calls the physics tick and handles the cleanup at stabilized.
   *
   */
  simulationStep() {
    if (this.physicsWorker) {
      this.physicsWorker.postMessage({type: 'physicsTick'});
    } else {
      // check if the physics have settled
      var startTime = Date.now();
      this.physicsTick();
      var physicsTime = Date.now() - startTime;

      // run double speed if it is a little graph
      if ((physicsTime < 0.4 * this.simulationInterval || this.runDoubleSpeed === true) && this.stabilized === false) {
        this.physicsTick();

        // this makes sure there is no jitter. The decision is taken once to run it at double speed.
        this.runDoubleSpeed = true;
      }
    }

    if (this.stabilized === true) {
      this.stopSimulation();
    }
  }

  _sendWorkerStabilized() {
    if (this.physicsWorker) {
      this.physicsWorker.postMessage({
        type: 'stabilized'
      });
    }
  }

  /**
   * trigger the stabilized event.
   * @private
   */
  _emitStabilized(amountOfIterations = this.stabilizationIterations) {
    if (this.stabilizationIterations > 1 || this.startedStabilization === true) {
      setTimeout(() => {
        this.body.emitter.emit('stabilized', {iterations: amountOfIterations});
        this.startedStabilization = false;
        this.stabilizationIterations = 0;
        this._sendWorkerStabilized();
      }, 0);
    }
  }

  createPhysicsNode(nodeId) {
    let node = this.body.nodes[nodeId];
    if (node) {
      return {
        id: node.id.toString(),
        x: node.x,
        y: node.y,
        // TODO update on change
        edges: {
          length: node.edges.length
        },
        options: {
          fixed: {
            x: node.options.fixed.x,
            y: node.options.fixed.y
          },
          mass: node.options.mass
        }
      }
    }
  }

  createPhysicsEdge(edgeId) {
    let edge = this.body.edges[edgeId];
    if (edge && edge.options.physics === true) {
      let physicsEdge = {
        id: edge.id,
        connected: edge.connected,
        edgeType: {},
        toId: edge.toId,
        fromId: edge.fromId,
        options: {
          length: edge.length
        }
      };
      // TODO test/implment dynamic
      if (edge.edgeType.via) {
        physicsEdge.edgeType = {
          via: {
            id: edge.edgeType.via.id
          }
        }
      }
      return physicsEdge;
    }
  }

  /**
   * Nodes and edges can have the physics toggles on or off. A collection of indices is created here so we can skip the check all the time.
   *
   * @private
   */
  initPhysicsData() {
    let nodes = this.body.nodes;
    let edges = this.body.edges;

    this.physicsBody.forces = {};
    this.physicsBody.physicsNodeIndices = [];
    this.physicsBody.physicsEdgeIndices = [];
    let physicsWorkerNodes = {};
    let physicsWorkerEdges = {};


    // get node indices for physics
    for (let nodeId in nodes) {
      if (nodes.hasOwnProperty(nodeId)) {
        if (nodes[nodeId].options.physics === true) {
          this.physicsBody.physicsNodeIndices.push(nodeId);
          if (this.physicsWorker) {
            physicsWorkerNodes[nodeId] = this.createPhysicsNode(nodeId);
          }
        }
      }
    }

    // get edge indices for physics
    for (let edgeId in edges) {
      if (edges.hasOwnProperty(edgeId)) {
        if (edges[edgeId].options.physics === true) {
          this.physicsBody.physicsEdgeIndices.push(edgeId);
          if (this.physicsWorker) {
            physicsWorkerEdges[edgeId] = this.createPhysicsEdge(edgeId);
          }
        }
      }
    }

    // get the velocity and the forces vector
    for (let i = 0; i < this.physicsBody.physicsNodeIndices.length; i++) {
      let nodeId = this.physicsBody.physicsNodeIndices[i];
      this.physicsBody.forces[nodeId] = {x:0,y:0};

      // forces can be reset because they are recalculated. Velocities have to persist.
      if (this.physicsBody.velocities[nodeId] === undefined) {
        this.physicsBody.velocities[nodeId] = {x:0,y:0};
      }
    }

    // clean deleted nodes from the velocity vector
    for (let nodeId in this.physicsBody.velocities) {
      if (nodes[nodeId] === undefined) {
        delete this.physicsBody.velocities[nodeId];
      }
    }

    if (this.physicsWorker) {
      this.physicsWorker.postMessage({
        type: 'initPhysicsData',
        data: {
          nodes: physicsWorkerNodes,
          edges: physicsWorkerEdges
        }
      });
    }
  }

  /**
   * This compares the reference state to the current state
   */
  _evaluateStepQuality() {
    let dx, dy, dpos;
    let nodes = this.body.nodes;
    let reference = this.referenceState;
    let posThreshold = 0.3;

    for (let nodeId in this.referenceState) {
      if (this.referenceState.hasOwnProperty(nodeId) && nodes[nodeId] !== undefined) {
        dx = nodes[nodeId].x - reference[nodeId].positions.x;
        dy = nodes[nodeId].y - reference[nodeId].positions.y;

        dpos = Math.sqrt(Math.pow(dx,2) + Math.pow(dy,2))

        if (dpos > posThreshold) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * move the nodes one timestep and check if they are stabilized
   * @returns {boolean}
   */
  moveNodes() {
    var nodeIndices = this.physicsBody.physicsNodeIndices;
    var maxVelocity = this.options.maxVelocity ? this.options.maxVelocity : 1e9;
    var maxNodeVelocity = 0;
    var averageNodeVelocity = 0;

    // the velocity threshold (energy in the system) for the adaptivity toggle
    var velocityAdaptiveThreshold = 5;

    for (let i = 0; i < nodeIndices.length; i++) {
      let nodeId = nodeIndices[i];
      let nodeVelocity = this._performStep(nodeId, maxVelocity);
      // stabilized is true if stabilized is true and velocity is smaller than vmin --> all nodes must be stabilized
      maxNodeVelocity = Math.max(maxNodeVelocity,nodeVelocity);
      averageNodeVelocity += nodeVelocity;
    }

    // evaluating the stabilized and adaptiveTimestepEnabled conditions
    this.adaptiveTimestepEnabled = (averageNodeVelocity/nodeIndices.length) < velocityAdaptiveThreshold;
    this.stabilized = maxNodeVelocity < this.options.minVelocity;
  }


  /**
   * Perform the actual step
   *
   * @param nodeId
   * @param maxVelocity
   * @returns {number}
   * @private
   */
  _performStep(nodeId,maxVelocity) {
    let node = this.body.nodes[nodeId];
    let timestep = this.timestep;
    let forces = this.physicsBody.forces;
    let velocities = this.physicsBody.velocities;

    // store the state so we can revert
    this.previousStates[nodeId] = {x:node.x, y:node.y, vx:velocities[nodeId].x, vy:velocities[nodeId].y};

    if (node.options.fixed.x === false) {
      let dx   = this.modelOptions.damping * velocities[nodeId].x;   // damping force
      let ax   = (forces[nodeId].x - dx) / node.options.mass;        // acceleration
      velocities[nodeId].x += ax * timestep;                         // velocity
      velocities[nodeId].x = (Math.abs(velocities[nodeId].x) > maxVelocity) ? ((velocities[nodeId].x > 0) ? maxVelocity : -maxVelocity) : velocities[nodeId].x;
      node.setX(node.x + velocities[nodeId].x * timestep);           // position
    }
    else {
      forces[nodeId].x = 0;
      velocities[nodeId].x = 0;
    }

    if (node.options.fixed.y === false) {
      let dy   = this.modelOptions.damping * velocities[nodeId].y;    // damping force
      let ay   = (forces[nodeId].y - dy) / node.options.mass;         // acceleration
      velocities[nodeId].y += ay * timestep;                          // velocity
      velocities[nodeId].y = (Math.abs(velocities[nodeId].y) > maxVelocity) ? ((velocities[nodeId].y > 0) ? maxVelocity : -maxVelocity) : velocities[nodeId].y;
      node.setY(node.y + velocities[nodeId].y * timestep);            // position
    }
    else {
      forces[nodeId].y = 0;
      velocities[nodeId].y = 0;
    }

    let totalVelocity = Math.sqrt(Math.pow(velocities[nodeId].x,2) + Math.pow(velocities[nodeId].y,2));
    return totalVelocity;
  }


  /**
   * calculate the forces for one physics iteration.
   */
  calculateForces() {
    this.gravitySolver.solve();
    this.nodesSolver.solve();
    this.edgesSolver.solve();
  }



  /**
   * When initializing and stabilizing, we can freeze nodes with a predefined position. This greatly speeds up stabilization
   * because only the supportnodes for the smoothCurves have to settle.
   *
   * @private
   */
  _freezeNodes() {
    var nodes = this.body.nodes;
    for (var id in nodes) {
      if (nodes.hasOwnProperty(id)) {
        if (nodes[id].x && nodes[id].y) {
          this.freezeCache[id] = {x:nodes[id].options.fixed.x,y:nodes[id].options.fixed.y};
          nodes[id].setFixed(true);
        }
      }
    }
  }

  /**
   * Unfreezes the nodes that have been frozen by _freezeDefinedNodes.
   *
   * @private
   */
  _restoreFrozenNodes() {
    var nodes = this.body.nodes;
    for (var id in nodes) {
      if (nodes.hasOwnProperty(id)) {
        if (this.freezeCache[id] !== undefined) {
          nodes[id].setFixed({x: this.freezeCache[id].x, y: this.freezeCache[id].y});
        }
      }
    }
    this.freezeCache = {};
  }

  /**
   * Find a stable position for all nodes
   */
  stabilize(iterations = this.options.stabilization.iterations) {
    if (typeof iterations !== 'number') {
      console.log('The stabilize method needs a numeric amount of iterations. Switching to default: ', this.options.stabilization.iterations);
      iterations = this.options.stabilization.iterations;
    }

    if (this.physicsBody.physicsNodeIndices.length === 0) {
      this.ready = true;
      return;
    }

    // enable adaptive timesteps
    this.adaptiveTimestep = true && this.options.adaptiveTimestep;

    // this sets the width of all nodes initially which could be required for the avoidOverlap
    this.body.emitter.emit("_resizeNodes");

    // stop the render loop
    this.stopSimulation();

    // set stabilize to false
    this.stabilized = false;

    // block redraw requests
    this.body.emitter.emit('_blockRedraw');
    this.targetIterations = iterations;

    // start the stabilization
    if (this.options.stabilization.onlyDynamicEdges === true) {
      this._freezeNodes();
    }
    this.stabilizationIterations = 0;


    if (this.physicsWorker) {
      this.physicsWorker.postMessage({
        type: 'stabilize',
        data: {
          targetIterations: iterations
        }
      });
    } else {
      setTimeout(() => this._stabilizationBatch(), 0);
    }
  }


  /**
   * One batch of stabilization
   * @private
   */
  _stabilizationBatch() {
    var self = this;
    var running = () => (self.stabilized === false && self.stabilizationIterations < self.targetIterations);
    var sendProgress = () => {
      self.body.emitter.emit('stabilizationProgress', {
        iterations: self.stabilizationIterations,
        total: self.targetIterations
      });
    };

    // this is here to ensure that there is at least one start event.
    if (this.startedStabilization === false) {
      this.body.emitter.emit('startStabilizing');
      this.startedStabilization = true;
      sendProgress();
    }

    var count = 0;
    while (this.stabilized === false && count < this.options.stabilization.updateInterval && this.stabilizationIterations < this.targetIterations) {
      this.physicsTick();
      count++;
    }
  
    if (this.stabilized === false && this.stabilizationIterations < this.targetIterations) {
      this.body.emitter.emit('stabilizationProgress', {iterations: this.stabilizationIterations, total: this.targetIterations});
      setTimeout(this._stabilizationBatch.bind(this),0);
    }
    else {
      this._finalizeStabilization();
    }
  }


  /**
   * Wrap up the stabilization, fit and emit the events.
   * @private
   */
  _finalizeStabilization() {
    this.body.emitter.emit('_allowRedraw');
    if (this.options.stabilization.fit === true) {
      this.body.emitter.emit('fit');
    }

    if (this.options.stabilization.onlyDynamicEdges === true) {
      this._restoreFrozenNodes();
    }

    this.body.emitter.emit('stabilizationIterationsDone');
    this.body.emitter.emit('_requestRedraw');

    if (this.stabilized === true) {
      this._emitStabilized();
    }
    else {
      this.startSimulation();
    }

    this.ready = true;
  }


  _drawForces(ctx) {
    for (var i = 0; i < this.physicsBody.physicsNodeIndices.length; i++) {
      let node = this.body.nodes[this.physicsBody.physicsNodeIndices[i]];
      let force = this.physicsBody.forces[this.physicsBody.physicsNodeIndices[i]];
      let factor = 20;
      let colorFactor = 0.03;
      let forceSize = Math.sqrt(Math.pow(force.x,2) + Math.pow(force.x,2));

      let size = Math.min(Math.max(5,forceSize),15);
      let arrowSize = 3*size;

      let color = util.HSVToHex((180 - Math.min(1,Math.max(0,colorFactor*forceSize))*180) / 360,1,1);

      ctx.lineWidth = size;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(node.x,node.y);
      ctx.lineTo(node.x+factor*force.x, node.y+factor*force.y);
      ctx.stroke();

      let angle = Math.atan2(force.y, force.x);
      ctx.fillStyle = color;
      ctx.arrowEndpoint(node.x + factor*force.x + Math.cos(angle)*arrowSize, node.y + factor*force.y+Math.sin(angle)*arrowSize, angle, arrowSize);
      ctx.fill();
    }
  }


}

export default PhysicsEngine;
