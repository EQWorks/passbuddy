# PassBuddy Semaphore
PassBuddy is a Redis _semaphore_ implementation.
- Semaphores allow controlled access to resources shared across multiple self-contained consumers (e.g. lamba or server instances).
- Each consumer can temporarily claim access to a resource by acquiring a permit.
- The semaphore oversees the permit acquisition process and denies access when no more permits are available for grabs.
- Consumers are expected to release a permit once they are done using the protected resource.
- Likewise, consumers must not return a permit before executing any teardown logic needed to free up the underlying resource.

## Redis Remote Storage:
The semaphore's global state persists as a Redis sorted set. The set associates member/score pairs, respectivelly a uuid generated for the local permit instance and the semaphore's timeout.

Other Redis implementation: [redislabs.com](https://redislabs.com/ebook/part-2-core-concepts/chapter-6-application-components-in-redis/6-3-counting-semaphores/)

## Interface
- acquire() - Makes a call to the Redis remote server to acquire or extend the permit's validity
- release() - Makes a call to the Redis remote server to release the permit
- use() - Proceeds if a permit is held, otherwise makes a call to the remote server to acquire one
- bind() - Binds a resource to the semaphore (returns a function which own return value is a promise resolving to the callback's return value)
- handler() - Returns an Express middleware performing permit acquisition on entry and/or permit release on server response
- client - Getter for the underlying Redis Client
- isHeld - Getter for the permit status (true is a permit has been acquired, false otherwise)

## Constructor Options
```
const options = {
  prefix: string,          // Redis key prefix - default: 'passbuddy'
  name: string,            // semaphore name - is appended to the prefix - default: 'semaphore'
  capacity: number,        // max number of permits that may be acquired - default: 10
  TTL: number,             // time (in milliseconds) before the permit is automatically released - default: 5000
  maxAttempts: number,     // max number of permit acquisition attempts before timing out when the semaphore is at capacity - default: 5
  retryInterval: number,   // time (in milliseconds) between each acquisition attempt - default: 500
  redisOptions: string,    // Full list of options, including defaults, available on Node Redis' NPM page (link below))
  redisClient: RedisClient // Node Redis' client; takes precedence over redisOptions if supplied
}
```

Node Redis' client options: [NPM](https://www.npmjs.com/package/redis#options-object-properties)

__All local PassBuddy instances of the same semaphore should use the same set of options.__

## Example - Express Application
```
const PassBuddy = require('@eqworks/passbuddy')

// instantiate PassBuddy
const passOptions = {
  prefix: `passbuddy-${STAGE}`,
  name: 'testlock',
  redisOptions: { host: REDIS_HOST, port: REDIS_PORT },
}

const pass = new PassBuddy(passOptions)

// binding node-pg's pool.query method to the pass
const query = pass.bind((...args) => pool.query(...args))
// and then using it
const { rows } = await query('SELECT...', ...params)

// register middleware to release the semaphore when the application responds
app.use(pass.handler({ releaseOnEnd: true }))

// use the semaphore before running a node-pg query
pass.use()
  .then(() => pool.query(...))

// using acquire
await pass.acquire()
const { rows } = await pool.query('SELECT...', ...params)
```

## Install
```yarn add @eqworks/passbuddy```

or

```npm install @eqworks/passbuddy```


