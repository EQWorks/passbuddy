
/**
 * PASSBUDDY SEMAPHORE CLASS
 * USES REDIS TO SHARE STATE BETWEEN SERVER/APP INSTANCES
 * */

// eslint-disable-next-line max-classes-per-file
const redis = require('redis')
const { v4: uuidv4 } = require('uuid')
const { promisify } = require('util')
const onFinished = require('on-finished')


class PassBuddyCapacityError extends Error {
  constructor(name) {
    super(`Semaphore ${name} is at capacity. No permit could be acquired.`)
    this.name = 'PassBuddyCapacityError'
  }
}

class PassBuddyRedisError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PassBuddyRedisError'
  }
}

// lazy init Redis client
const _redisClient = (options) => {
  let client

  const initRedisClient = (options) => {
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

    const client = redis.createClient({ retry_strategy, ...options })

    client.on('error', (err) => {
      throw new PassBuddyRedisError(`Error with Redis client: ${err.message}`)
    })

    return client
  }

  // init and/or returns client
  return () => {
    if (!client) {
      client = initRedisClient(options)
    }
    return client
  }
}

const _genLuaScript = (prefix, name, uuid, capacity, TTL) => {
  // aws uses NTP to synchronize clocks across lambda instances to within seconds
  // redis server time only allows precision to the second
  // therefore we can safely rely on Date.now() to estimate current time
  // across all lambda instances
  // https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html

  const key = `${prefix}-${name}`
  const now = Date.now()
  const expired = now - TTL
  const expiry = now + TTL

  // script returns an array
  // first array element is 1 if permit acquired, 0 otherwise
  // second element is the permit expiry in milliseconds
  return `
    -- remove expired accesses
    redis.call('ZREMRANGEBYSCORE', '${key}', '-inf', ${expired})
    
    -- add/update uuid
    local expiry = ${expiry}
    redis.call('ZADD', '${key}', expiry, '${uuid}')
    
    -- get number of valid accesses
    local count = redis.call('ZCARD', '${key}')
    
    -- remove newly added uuid if count exceeds max
    local acquired = 1
    if count > ${capacity} then
      redis.call('ZREM', '${key}', '${uuid}')
      acquired = 0
      expiry = 0
      count = count - 1
    end

    return {acquired, expiry}
  `
}

// instructs redis to execute the acquisition script server-side
// return [1, expiry (in ms)] if successful, throws and error otherwise
const _acquire = async (client, prefix, name, uuid, capacity, TTL) => {
  try {
    const res = await promisify(client.send_command).bind(client)(
      'eval',
      [_genLuaScript(prefix, name, uuid, capacity, TTL), '0'],
    )

    if (!res[0]) {
      throw new PassBuddyCapacityError(name)
    }

    return res
  } catch (err) {
    throw new PassBuddyRedisError(
      `Redis error while attempting to acquire a permit for semaphore ${name}: ${err.message}`,
    )
  }
}

// sets key/value and returns redis response
const _release = async (client, prefix, name, uuid) => {
  try {
    return await promisify(client.zrem).bind(client)(`${prefix}-${name}`, uuid)
  } catch (err) {
    throw new PassBuddyRedisError(
      `Redis error while attempting to release a permit for semaphore ${name}: ${err.message}`,
    )
  }
}

class PassBuddy {
  /**
   * Create a PassBuddy (semaphore permit)
   * @param {{prefix: string, name: string, capacity: number, TTL: number,
   * maxAttempts: number, retryInterval: number, redisOptions: redis.ClientOpts,
   * redisClient: redis.RedisClient}} options - TTL and retryInterval are expressed in milliseconds
   * @return {PassBuddy}
   */
  constructor(options) {
    this._prefix = options.prefix || 'passbuddy'
    this._name = options.name || 'semaphore'
    this._capacity = options.capacity || 10
    this._TTL = options.TTL || 5000 // in milliseconds
    this._maxAttempts = options.maxAttempts || 5
    this._retryInterval = options.retryInterval || 500 // in milliseconds
    this._client = options.redisClient instanceof redis.RedisClient
      ? options.redisClient
      : _redisClient(options.redisOptions)
    this._uuid = uuidv4()
    this._isHeldUntil = 0 // in milliseconds
  }

  /**
   * Getter for the Redis Client
   * @return {redis.RedisClient}
   */
  get client() {
    return this._client instanceof redis.RedisClient ? this._client : this._client()
  }

  /**
   * Getter for the permit status
   * @return {boolean}
   */
  get isHeld() {
    return this._isHeldUntil > Date.now()
  }

  /**
   * Makes a call to the Redis remote server to acquire or extend the permit's validity
   * @param {number} [attempts=0] - Number of failed attempts before current call
   * @return {Promise<true>}
   */
  async acquire(attempts = 0) {
    try {
      const [_, isHeldUntil] = await _acquire(
        this.client, this._prefix, this._name,
        this._uuid, this._capacity, this._TTL,
      )
      this._isHeldUntil = isHeldUntil

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
   * Makes a call to the Redis remote server to release the permit
   * @return {Promise<true>}
   */
  async release() {
    await _release(this.client, this._prefix, this._name, this._uuid)
    this._isHeldUntil = 0

    return true
  }

  /**
   * Proceeds if a permit is held, otherwise makes a call to the remote server to acquire one
   * @return {Promise<true>}
   */
  async use() {
    return this.isHeld ? true : this.acquire()
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

        // let's await to make sure the callack is done with the resource
        // before potentially releasing it in finally
        return await callback(...args)
      } finally {
        if (releaseOnComplete) {
          this.release()
        }
      }
    }
  }

  /**
   * Express middleware to:
   * - Acquire/extend permit for each incoming request
   * - Release permit on response/error
   * @param {{acquireOnStart: boolean, releaseOnEnd: boolean}} options
   * @return {Function} - Express middleware
   */
  handler({ acquireOnStart = false, releaseOnEnd = true } = {}) {
    return async (req, res, next) => {
      try {
        if (releaseOnEnd) {
          onFinished(res, () => this.release())
        }

        if (acquireOnStart) {
          await this.acquire()
        }

        next()
      } catch (err) {
        next(err)
      }
    }
  }
}

module.exports = PassBuddy
module.exports.PassBuddy = PassBuddy
module.exports.PassBuddyCapacityError = PassBuddyCapacityError
module.exports.PassBuddyRedisError = PassBuddyRedisError
