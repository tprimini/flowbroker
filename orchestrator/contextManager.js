
"use strict";

var config = require('./config');
var zmq = require('zeromq');
var redis_client = require('redis');
var redis_lock = require('redis-lock');
const { promisify } = require('util');

function checkField(target, field, message) {
  if (!target.hasOwnProperty(field)) {
    throw new Error(message);
  }
}

class RemoteNodeInfo {
  constructor(remote_node_name, unlock_callback) {
    //TODO: for multiple instance environment, it must contain remote node information.
    // It seems like zmq does not provide remote peer info, so we have to find a way to get
    // this info in order to prevent instances to unlock lockers which are not of its responsibility.
    this.remote_node_name = remote_node_name;
    this.unlock_callback = unlock_callback;
  }

  get_remote_node_name() {
    return this.remote_node_name;
  }

  get_unlock_callback() {
    return this.unlock_callback;
  }
}

class ContextHandler {
  constructor() {
    this.handleResults = this.handleResults.bind(this);
  }

  init() {
    this.handleResults.bind(this);

    this.cb_unlock_map = {};

    this.redisClient = redis_client.createClient({'host': config.redis.host});
    this.redisClient.on("error", function (err) {
      console.log("Redis client error " + err);
    });

    this.lock = promisify(redis_lock(this.redisClient));

    this.sock = zmq.socket('rep');

    this.sock.on("message", (request) => {
      let data;
      try {
        data = JSON.parse(request.toString());
      } catch (error) {
        return this.handleResults(new Error("Payload must be valid json"));
      }

      try {
        checkField(data, 'command', "Request is missing command field");
        console.log('Got message. invoking handler ...', data);
        switch (data.command) {
          case 'lock_and_get':
            this._lock_and_get(data);
            break;
          case 'save_and_unlock':
            this._save_and_unlock(data);
            break
          default:
            this.handleResults(new Error("Unknown command requested"));
        }
      } catch (error) {
        return this.handleResults(error);
      }
    });

    this.sock.bind('tcp://*:5556', (err) => {
      if (err) {
        console.err(err);
        process.exit(1);
      } else {
        console.log('listening on 5556');
      }
    });

    process.on('SIGINT', () => {
      this.sock.close();
    });
  }

  handleResults(error, response) {
    if (error) {
      console.error("Message processing failed", error)
      return this.sock.send(JSON.stringify({"error": error}));
    }

    const output = JSON.stringify(response);
    console.log('Results: ', output)
    return this.sock.send(output);
  }

  _lock_and_get(data) {
    checkField(data, 'context_name', "Request is missing context_name field");

    this.lock(data.context_name, config.redis.lockTimeout).then(unlock => {
      try {
        this.redisClient.get(data.context_name, function (err, reply) {
          if (err) {
            this.handleResults(err, undefined);
            unlock();
          } else {
            this.handleResults(undefined, { serialized_context: reply.toString() });
            console.log(data.context_name + " = " + reply.toString());
            this.cb_unlock_map[data.context_name] = new RemoteNodeInfo(undefined, unlock);
            console.log("lock is on for: " + data.context_name);
          }
        });
      } catch (e) {
        console.error("Error during locking " + data.context_name);
        unlock();
      }
    });
  }

  _save_and_unlock(data) {
    checkField(data, 'context_name', "Request is missing context_name field");
    checkField(data, 'context_value', "Request is missing context_name field");

    let remote_node_info = this.cb_unlock_map[data.context_name];

    if (remote_node_info != undefined) {
      // if we are here so there is a lock activated
      try {
        this.redisClient.set(data.context_name, data.context_value, function (err, reply) {
          if (err) {
            this.handleResults(err, undefined);
          } else {
            this.handleResults(undefined, { status: reply.toString() });
            console.log(data.context_name + " = " + data.context_value);
          }
        });
      } catch (e) {
        console.error("Error during locking " + data.context_name);
        unlock();
      }

      let unlock_callback = remote_node_info.get_unlock_callback();
      unlock_callback();

      console.log("lock is off for: " + data.context_name);

      delete this.cb_unlock_map[data.context_name];
    }
  }
}

module.exports = { ContextHandler: new ContextHandler() };
