
/**
 * PASSBUDDY SEMAPHORE CLASS
 * USES REDIS TO SHARE STATE BETWEEN SERVER/APP INSTANCES
 * */

// eslint-disable-next-line max-classes-per-file
const redis = require('redis')
const { v4: uuidv4 } = require('uuid')
const onFinished = require('on-finished')


class PassBuddyCapacityError extends Error {
  constructor(name) {
    super(`Semaphore ${name} is at capacity`)
    this.name = 'PassBuddyCapacityError'
  }
}

class PassBuddyRedisError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PassBuddyRedisError'
  }
}

// lazily loads Redis client
// returns a promise
const _redisClient = (host, port) => {
  let client = null

  const initRedisClient = (host, port) => {
    const retry_strategy = (options) => {
      if (options.error && options.error.code === 'ECONNREFUSED') {
        // End reconnecting on a specific error and flush all commands with
        // a individual error
        return new PassBuddyRedisError('The server refused the connection')
      }
      if (options.total_retry_time > 1000 * 60 * 5) {
        // End reconnecting after a specific timeout (5 mins) and flush all commands
        // with a individual error
        return new PassBuddyRedisError('Retry time exhausted')
      }
      if (options.attempt > 10) {
        // End reconnecting with built in error
        return new PassBuddyRedisError('No more tries')
      }
      // reconnect after (all in ms)
      return Math.min(options.attempt * 100, 3000)
    }

    return new Promise((resolve, reject) => {
      const client = redis.createClient(port, host, { retry_strategy })

      client.on('error', (err) => {
        reject(new PassBuddyRedisError(`Error with Redis client: ${err.message}`))
      })

      client.on('ready', () => {
        resolve(client)
      })
    })
  }

  // init and/or returns client
  return async () => {
    if (!client) {
      client = initRedisClient(host, port)
    }
    return client
  }
}

const _genLuaScript = (prefix, name, uuid, capacity, TTL) => {
  // set future TS to one hour from now in case the
  // express server's time is behind Redis'
  const futureTS = Math.floor((Date.now() / 1000) + 0.5) + 3600
  // script returns 1 if acquired, 0 otherwise
  return `
    -- get server timestamp
    redis.call('SET', '${prefix}-redis-timestamp', '1')
    redis.call('EXPIREAT', '${prefix}-redis-timestamp', ${futureTS})
    local TTL = redis.call('TTL', '${prefix}-redis-timestamp')
    local currentTS = ${futureTS} - TTL

    -- remove expired accesses
    redis.call('ZREMRANGEBYSCORE', '${prefix}-${name}', '-inf', currentTS - ${TTL})
    
    -- add/update uuid
    redis.call('ZADD', '${prefix}-${name}', currentTS + ${TTL}, '${uuid}')
    
    -- get number of valid accesses
    local count = redis.call('ZCARD', '${prefix}-${name}')
    
    -- remove newly added uuid if count exceeds max
    local acquired = 1
    if count > ${capacity} then
      redis.call('ZREM', '${prefix}-${name}', '${uuid}')
      acquired = 0
      count = count - 1
    end

    return acquired
  `
}

// instructs redis to execute the acquisition script server-side
// return 1 if successful, throws and error otherwise
// eslint-disable-next-line arrow-body-style
const _acquire = (client, prefix, name, uuid, capacity, TTL) => new Promise((resolve, reject) => {
  client.send_command(
    'eval',
    [_genLuaScript(prefix, name, uuid, capacity, TTL), '0'],
    (err, res) => {
      if (err) {
        reject(new PassBuddyRedisError(
          `Redis error while attempting to acquire semaphore ${name}: ${err.message}`,
        ))
        return
      }

      if (!res) {
        reject(new PassBuddyCapacityError(name))
        return
      }
      resolve(res)
    },
  )
})

// sets key/value and returns redis response
// eslint-disable-next-line arrow-body-style
const _release = (client, prefix, name, uuid) => new Promise((resolve, reject) => {
  client.zrem(`${prefix}-${name}`, uuid, (err, res) => {
    if (err) {
      reject(new PassBuddyRedisError(
        `Redis error while attempting to release semaphore ${name}: ${err.message}`,
      ))
      return
    }
    resolve(res)
  })
})


class PassBuddy {
  /**
   * Create a PassBuddy (semaphore)
   * @param {{prefix: string, name: string, capacity: number, TTL: number,
   * maxAttempts: number, retryInterval: number, host: string,
   * port: number}} options - TTL is in seconds while retryInterval is in milliseconds
   * @return {PassBuddy}
   */
  constructor(options) {
    this._prefix = options.prefix || 'passbuddy'
    this._name = options.name || 'semaphore'
    this._capacity = options.capacity || 10
    this._TTL = options.TTL || 5 // in seconds
    this._maxAttempts = options.maxAttempts || 5
    this._retryInterval = options.retryInterval || 500 // in milliseconds
    this._client = _redisClient(options.host || '127.0.0.1', options.port || 6379)
    this._uuid = uuidv4()
    this._isHeld = false
    this._timeout = 0
  }

  /**
   * Getter for the Redis Client
   * @return {Promise<RedisClient>}
   */
  get client() {
    return this._client()
  }

  /**
   * Makes a call to the Redis remote server to acquire or extend the semaphore's validity
   * @param {number} [attempts=0] - Number of failed attempts before current call
   * @return {Promise<true>}
   */
  async acquire(attempts = 0) {
    try {
      await _acquire(
        await this.client, this._prefix, this._name,
        this._uuid, this._capacity, this._TTL,
      )

      this._isHeld = true
      clearTimeout(this._timeout)
      this._timeout = setTimeout(() => { this._isHeld = false }, this._TTL * 1000)

      return true
    } catch (err) {
      // retry if capacity error
      if (attempts < this._maxAttempts && err instanceof PassBuddyCapacityError) {
        return new Promise((resolve, _) => {
          setTimeout(() => resolve(this.acquire(attempts + 1)), this._retryInterval)
        })
      }

      throw err
    }
  }

  /**
   * Makes a call to the Redis remote server to releaser the semaphore
   * @return {Promise<true>}
   */
  async release() {
    await _release(await this.client, this._prefix, this._name, this._uuid)

    this._isHeld = false
    clearTimeout(this._timeout)

    return true
  }

  /**
   * Acquires the semaphore if not already held
   * @return {Promise<true>}
   */
  async use() {
    return this._isHeld ? true : this.acquire()
  }

  /**
   * Binds any resource (callback) to the semaphore
   * @param {Function} callback
   * @return {Function} - Function returning a promise resolving to the callback's return value
   */
  bind(callback, releaseOnComplete = false) {
    return async (...args) => {
      try {
        await this.use()
        let output = callback(...args)

        // let's await to make sure the callack is done with the resource
        // before releasing it in finally
        if (releaseOnComplete) {
          output = output instanceof Promise ? await output : output
        }

        return output
      } finally {
        this.release()
      }
    }
  }

  /**
   * Express middleware to:
   * - Acquire/extend semaphore for each incoming request
   * - Release semaphore on response/error
   * @param {{acquireOnStart: boolean, releaseOnEnd: boolean}} options
   * @return {Function} - Express middleware
   */
  handler({ acquireOnStart = false, releaseOnEnd = true } = {}) {
    return async (req, res, next) => {
      if (acquireOnStart) {
        await this.acquire()
      }

      if (releaseOnEnd) {
        onFinished(res, () => this.release())
      }

      next()
    }
  }
}

module.exports = PassBuddy
module.exports.PassBuddy = PassBuddy
module.exports.PassBuddyCapacityError = PassBuddyCapacityError
module.exports.PassBuddyRedisError = PassBuddyRedisError
