# PassBuddy Semaphore
PassBuddy is a Redis semaphore implementation.
- Semaphores allow controlled access to resources shared across multiple self-contained consumers (e.g. lamba or server instances).
- Each consumer can temporarily claim access to a resource by acquiring a lock.
- The semaphore oversees the lock acquisition process and denies access when no more locks are available for grabs.
- Consumers are expected to release the lock once they are done using the resource.

## Redis Remote Storage:
The semaphore's global state persists as a Redis sorted set. The set associates member/score pairs, respectivelly a uuid generated for the local semaphore instance and the semaphore's timeout (
Other Redis implementation: [redislabs.com](https://redislabs.com/ebook/part-2-core-concepts/chapter-6-application-components-in-redis/6-3-counting-semaphores/)

## Interface
- acquire() - Makes a call to the Redis remote server to acquire or extend the semaphore's validity
- release() - Makes a call to the Redis remote server to releaser the semaphore
- use() - Acquires the semaphore if not already held
- bind() - Binds a resource to the semaphore (returns a function which own return value is a promise resolving to the callback's return value)
- handler() Returns an Express middleware
- client - Getter for the underlying Redis Client

## Example - Express Application
```
const PassBuddy = require('eq-passbuddy')

// instantiate PassBuddy
const passOptions = {
  prefix: `passbuddy-${STAGE}`,
  name: 'testlock',
  host: REDIS_HOST,
  port: REDIS_PORT,
}

const pass = new PassBuddy(passOptions)

// binding node-pg's pool.query method to the pass
const query = pass.bind((...args) pool.query(...args))

// register middleware to release the semaphore when the application responds
app.use(pass.handler({ releaseOnEnd: true }))

// use the semaphore before running a node-pg query
pass.use()
  .then(() => pool.query(...))
```

## Install
```yarn add https://github.com/EQWorks/passbuddy/```


