const express = require('express')
const PassBuddy = require('./semaphore')


const { REDIS_HOST, REDIS_PORT, STAGE = 'dev' } = process.env

const app = express()

const passOptions = {
  prefix: `passbuddy-${STAGE}`,
  name: 'testlock',
  host: REDIS_HOST,
  port: REDIS_PORT,
}
const pass = new PassBuddy(passOptions)

// bind log function to pass
const log = pass.bind(console.log)

// register middleware
app.use(pass.handler({ releaseOnEnd: true }))

app.get('/', async (req, res) => {
  // await pass.use()

  log('hello', pass._uuid)



  const client = await pass.client
  client.zscore(`${pass._prefix}-${pass._name}`, `${pass._uuid}`, (err, res) => {
    if (err) {
      console.error(`[ERROR] ZSCORE, key: ${pass._uuid}`, err)
    }
    console.error(`ZSCORE, key: ${res}`)
  })

  client.zrange(`${pass._prefix}-${pass._name}`, 0, 2586736811, (err, res) => {
    if (err) {
      console.error(`[ERROR] ZRANGE, key: ${pass._uuid}`, err)
    }
    console.error(`ZRANGE, values: ${res}`)
  })

  res.send('Success')

})

app.listen('3000', () => console.log('demo app listening on 3000'))


// if (require.main === module) {
//   test()
// }
