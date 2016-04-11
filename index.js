"use strict";
var EventEmitter = require('events');
var noop = function () {
};

function Sifaka(backend, options) {
    EventEmitter.call(this);
    var self = this;

    this.options = options || {};
    this.backend = backend;
    this.storage = {};
    this.debugLogger = (options.debug === true ? console.log : options.debug) || null;
    this.initialLockCheckDelayMs = typeof options.initialLockCheckDelayMs !== "undefined" ? options.initialLockCheckDelayMs : 20; // Wait this long before performing the first lock check
    this.lockCheckIntervalMs = typeof options.lockCheckIntervalMs !== "undefined" ? options.lockCheckIntervalMs : 50; // After the first check, wait another (lockCheckIntervalMs + n* lockCheckBackoff)
    this.lockCheckBackoff = typeof options.lockCheckBackoff !== "undefined" ? options.lockCheckBackoff : 50;
    this.cachePolicy = options.cachePolicy || new (require("./cache_policies/static"))();
    this.statsInterval = options.statsInterval || 0;
    this.serializer = options.serializer || null;
    this.stats = {hit: 0, miss: 0, work: 0};
    this.name = options.name || null;
    this.lockTimeoutMs = options.lockTimeoutMs || 120 * 1000;
    this.pendingTimeoutMs = options.pendingTimeoutMs || this.lockTimeoutMs;

    if(this.statsInterval) {
        this.lastStats = new Date();
        setTimeout(function () {
            self._logStats();
        }, this.statsInterval);
    }

    if(this.debugLogger) {
        this.debug("", "---- Initialising Cache ----")
    }

    this.namespace = options.namespace || null;
    this.pendingCallbacks = {};
    this.pendingTimeouts = {};
    this.remoteLockChecks = {};
    this.localLocks = {};
    this.lockCheckCounts = {};

}

require("util").inherits(Sifaka, EventEmitter);

Sifaka.prototype.debug = function (key, message) {
    if(this.namespace) {
        message = this.namespace + ":" + key + "\t" + message;
    } else {
        message = key + "\t" + message;
    }

    if(this.name) {
        message = "[" + this.name + "]\t" + message;
    }

    if(this.debugLogger) {
        this.debugLogger(new Date() * 1 + "\t" + message);
    }
};

Sifaka.prototype.toString = function () {
    var message = "Sifaka";
    if(this.name) {
        message += " [" + this.name + "]\n";
    }

    message += require("util").inspect(this.stats);
    return message;
};

Sifaka.prototype.exists = function (key, options, callback) {
    if(arguments.length === 2 && typeof arguments[1] === "function") {
        callback = options;
        options = {};
    }
    this.backend.exists(key, options, callback);
};

Sifaka.prototype.get = function (key, workFn, options, callback) {
    var self = this;

    if(arguments.length === 3 && typeof arguments[2] === "function") {
        callback = options;
        options = {};
    }
    if(options.metaOnly && ["hit", "miss"].indexOf(options.metaOnly) == -1) {
        throw new RangeError("options.metaOnly should be one of hit or miss");
    }

    self.debug(key, "GET");

    if(this._pendingQueueExists(key)) {
        // This node is already waiting for data on this key, add to the queue
        self.debug(key, "CACHE MISS - ADDING TO PENDING");
        self._addPending(key, callback, options);
    } else {
        // Otherwise, hit the backend
        self.backend.get(key, options, function (err, data, state, extra) {
            if(err) {
                if(typeof err === "string") {
                    err = new Error(err);
                }
                if(typeof err.cached === 'undefined') {
                    err.cached = true;
                }
            }

            if(state.hit === true) {
                self.stats.hit++;
                self.debug(key, "CACHE HIT");

                if(options.metaOnly === "hit") {
                    // Pass "data" through here - so that we can verify in the tests that the backends are returning
                    // undefined (and hopefully not fetching data from the store)
                    callback(err, data, state, extra);
                } else {
                    self._deserialize(data, extra, function (deserializeErr, deSerializedData, deSerializedExtra) {
                        callback(err || deserializeErr, deSerializedData, state, deSerializedExtra);
                    });
                }

                // check if we need to refresh the data in the background
                if(state.stale) {
                    self.stats.stale++;
                    if(!self._hasLocalLock(key)) {
                        self.backend.lock(key, null, function (err, acquired) {
                            if(acquired) {
                                self._setLocalLock(key);
                                self.debug(key, "GOT LOCK FOR STALE REFRESH");
                                self._doWork(key, options, workFn, state);
                            } else {
                                // TODO  - add in remote watch?
                                self.debug(key, "LOCK DENIED FOR STALE REFRESH");
                            }
                        });
                    } else {
                        self.debug(key, "STALE REFRESH SKIPPED - LOCK ALREADY HELD LOCALLY")
                    }
                }
            } else {
                self.stats.miss++;
                if(options.metaOnly === "miss") {
                    // We don't need to wait for a result to be calculated, or trigger one
                    self.debug(key, "META ONLY CACHE MISS");
                    return callback(err, void 0, state);
                }

                self._addPending(key, callback, options);
                self.debug(key, "CACHE MISS");

                if(err && err.cacheUnavailable === true) { // Failed to get, so lets try to do the work once, locally
                    // If we're already checking for a remote lock, add to the list
                    if(self._hasLocalLock(key)) {
                        self.debug(key, "UNABLE TO READ CACHE - ADDED TO PENDING");
                    } else {
                        self.debug(key, "UNABLE TO READ CACHE - DOING WORK");
                        self._setLocalLock(key);
                        self._doWork(key, options, workFn, state);
                    }
                } else {
                    if(self._hasLocalLock(key)) {
                        // Do nothing, we're already on the pending list, and have the lock.
                        return;
                    } else {

                        if(self._hasRemoteLockCheck(key)) {
                            // We know there's already a remote lock out there, and we should already be watching it.
                            // We're already on the pending list, so no need to do anything else
                            return;
                        } else {
                            // We don't know about a remote lock, so we have to try obtain it ourselves.
                            self.backend.lock(key, null, function (err, acquired) {
                                if(acquired === true) {
                                    // We got the lock ourselves, so we can do the work
                                    self._setLocalLock(key);
                                    self.debug(key, "GOT LOCK");
                                    self._doWork(key, options, workFn, state);
                                } else {
                                    self.debug(key, "WAITING FOR REMOTE LOCK / WORK");
                                    self._addRemoteLockCheck(key); // We need to poll for a result / lock expiry
                                }
                            });
                        }
                    }
                }
            }
        });
    }
};

Sifaka.prototype._addPending = function (key, callback, options) {
    var self = this;
    var pendingID = Math.floor((Math.random() * 1E12)).toString(36);
    this.debug(key, "PENDING ADDED: " + pendingID);
    this.pendingCallbacks[key] = this.pendingCallbacks[key] || [];
    if(!this.pendingTimeouts[key]){
        this.pendingTimeouts[key] = setTimeout(function(){
            self._clearPending(key);
        }, self.pendingTimeoutMs)
    }
    this.pendingCallbacks[key].push({options: options, cb: callback, id: pendingID});
};

/**
 * Clear any pending requests if we hit the timeout
 * @param key
 * @private
 */
Sifaka.prototype._clearPending = function (key) {
    if(this.pendingTimeouts[key]) {
        var timeout = this.pendingTimeouts[key];
        clearTimeout(timeout);
        delete this.pendingTimeouts[key];
        this.debug(key, "PENDING TIMED OUT");
        this._resolvePendingCallbacks(key, new Error("Timed Out"), null,  {}, false, {});
    }
};

Sifaka.prototype._pendingQueueExists = function (key) {
    if(this.pendingCallbacks[key] && this.pendingCallbacks[key].length) {
        return true;
    }
    return false;
};

Sifaka.prototype._calculateCacheTimes = function (key, duration, data, extra, state, options, callback) {
    options = options || {};
    extra = extra || {};
    (options.policy || this.cachePolicy).calculate(key, duration, data, extra, state, callback);
};
Sifaka.prototype._checkForBackendResult = function (key) {
    var self = this;

    this.backend.get(key, {noLock: true}, function (err, data, state, extra) {
        if(state.hit) {
            if(err) {
                if(typeof err === "string") {
                    err = new Error(err);
                }
                err.cached = true;
            }
            self.debug(key, "RESULT CHECK: HIT");

            if(self._hasRemoteLockCheck(key)) {
                self._removeRemoteLockCheck(key);
            }

            self._deserialize(data, extra, function (err, deSerializedData, deSerializedExtra) {
                self._resolvePendingCallbacks(key, err, deSerializedData, deSerializedExtra, false, state);
            });
        } else {
            self.lockCheckCounts[key] += 1;
            var nextInterval = self.lockCheckIntervalMs + (self.lockCheckCounts[key] * self.lockCheckBackoff);
                self.remoteLockChecks[key] = setTimeout(function () {
                    self._checkForBackendResult(key)
                }, nextInterval);
                self.debug(key, "RESULT CHECK: MISS - CHECKING AGAIN IN " + nextInterval + "ms");
        }
    });
};

Sifaka.prototype._serialize = function (data, extra, callback) {
    var serializer = this.options.serializer;
    if(serializer) {
        serializer.serialize(data, extra, {}, callback);
    } else {
        callback(null, data, extra);
    }
};
Sifaka.prototype._deserialize = function (data, extra, callback) {
    var serializer = this.options.serializer;
    if(serializer) {
        serializer.deserialize(data, extra, {}, callback);
    } else {
        callback(null, data, extra);
    }
};

Sifaka.prototype._doWork = function (key, options, workFunction, state, callback) {
    var self = this;
    self.debug(key, "TRIGGERING WORK");
    var start = new Date();
    workFunction(function (workError, data, extra, storedCallback) {
        if(arguments.length == 3 && typeof extra === "function") {
            storedCallback = extra;
            extra = null;
        }

        if(typeof extra == "undefined") {
            extra = null;
        }

        self.stats.work++;
        var duration = new Date() - start;
        if(workError && !workError.cache) {
            self.debug(key, "ERROR, NOT CACHED: " + workError + " - UNLOCKING");

            self.backend.unlock(key, {}, function () {
                self.debug(key, "UNLOCKED AFTER WORK THAT ERRORED");
                self._resolvePendingCallbacks(key, workError, data, extra, true, state);
            });
        } else {
            self._calculateCacheTimes(key, duration, data, extra, state, options, function (err, cachePolicyResult) {

                if(!cachePolicyResult.noCache) {

                    state.staleTime = cachePolicyResult.staleTimeAbs;
                    state.expiryTime = cachePolicyResult.expiryTimeAbs;

                    self._serialize(data, extra, function (err, serializedData, serializedExtra) {
                        self.debug(key, "STORING AND UNLOCKING....");
                        self.backend.store(key, serializedData, serializedExtra, workError, cachePolicyResult, {
                            unlock: true
                        }, function (storedError, storedResult) {
                            self._removeLocalLock(key);
                            self._resolvePendingCallbacks(key, workError, data, extra, true, state);
                            if(storedCallback) {
                                storedCallback(storedError, storedResult);
                            }
                        });
                    });
                } else {
                    self.debug(key, "UNLOCKING - NOCACHE FROM POLICY");
                    self.backend.unlock(key, options, function () {
                        self._removeLocalLock(key);
                        self._resolvePendingCallbacks(key, workError, data, extra, true, state);
                    });
                }

                // Needed?
                if(callback) {
                    callback(null);
                }
            });
        }
    });
};
Sifaka.prototype._logStats = function () {
    var self = this;
    var currentStats = this.stats;
    var lastStats = this.lastStats;
    this.lastStats = new Date();
    setTimeout(function () {
        self._logStats()
    }, this.statsInterval);
    currentStats.duration = this.lastStats - lastStats;
    this.stats = {hit: 0, miss: 0, work: 0};
    this.emit("stats", currentStats);
};
Sifaka.prototype._resolvePendingCallbacks = function (key, err, data, extra, didWork, state) {
    var self = this;
    if(self._hasRemoteLockCheck(key)) {
        self._removeRemoteLockCheck(key);
    }

    this.debug(key, "RESOLVING PENDING CALLBACKS");
    var pendingCallbacks = this.pendingCallbacks[key] || [];
    this.pendingCallbacks[key] = [];

    state.pending = true;
    while(pendingCallbacks.length) {
        var pending = pendingCallbacks.shift();

        this.debug(key, "RESOLVING CALLBACK: " + pending.id);
        var cb = pending.cb;
        var options = pending.options;

        if(options.metaOnly && options.metaOnly == "miss") {
            cb(err, void 0, state, extra);
        } else {
            cb(err, data, state, extra);
        }
    }
    this.debug(key, "RESOLVED ALL CALLBACKS");

};

Sifaka.prototype._hasLocalLock = function (key) {
    if(this.localLocks[key] && this.localLocks[key]._called !== true) {
        return true;
    }
    return false;
}

Sifaka.prototype._setLocalLock = function (key) {
    var self = this;
    this.localLocks[key] = setTimeout(function () {
        delete self.localLocks[key];
    }, self.lockTimeoutMs);
}

Sifaka.prototype._removeLocalLock = function (key) {
    var self = this;
    var lockTimeout = self.localLocks[key];
    delete self.localLocks[key];
    clearTimeout(lockTimeout);
}

/**
 * Is there anything waiting for a lock check to return?
 * @param key
 * @returns {boolean}
 * @private
 */
Sifaka.prototype._hasRemoteLockCheck = function (key) {
    if(this.remoteLockChecks[key]) {
        return true;
    }
    return false;
};

Sifaka.prototype._addRemoteLockCheck = function (key) {
    var self = this;

    if(!self._hasRemoteLockCheck(key)) {
        self.lockCheckCounts[key] = 0;
        self.remoteLockChecks[key] = setTimeout(function () {
            self._checkForBackendResult(key)
        }, self.options.initialLockCheckDelayMs);
        return;
    } else {
        return;
    }
};

Sifaka.prototype._removeRemoteLockCheck = function (key) {
    var self = this;
    if(self.remoteLockChecks[key]) {
        self.lockCheckCounts[key] = 0;
        clearTimeout(self.remoteLockChecks[key]);
        self.remoteLockChecks[key] = null;
    }
}

module.exports = {
    Sifaka: Sifaka,
    backends: require("./backends"),
    cache_policies: require("./cache_policies"),
    serializers: require("./serializers")
};