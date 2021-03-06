const BigNumber = require('bignumber.js')
const Promise = require('bluebird')

module.exports = (osseus) => {
  function transaction () {}

  const validateParticipant = (participant) => {
    return new Promise(async (resolve, reject) => {
      try {
        await osseus.db_models.community.getByWalletAddress(participant.accountAddress)
        let currency = await osseus.db_models.currency.getByCurrencyAddress(participant.currency)
        resolve({
          accountAddress: participant.accountAddress,
          currency: currency.id
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  const validateAmount = (amount) => {
    return new Promise(async (resolve, reject) => {
      amount = new BigNumber(amount)
      if (amount.lte(0)) {
        reject(new Error(`amount must be positive`))
      }
      if (amount.isNaN()) {
        reject(new Error(`amount illegal`))
      }
      resolve(amount)
    })
  }

  const validateAggregatedBalances = () => {
    return new Promise(async (resolve, reject) => {
      try {
        const results = await osseus.utils.validateAggregatedBalances()
        const invalid = results.filter(res => !res.valid)
        if (invalid.length > 0) {
          // TODO NOTIFY
          return reject(new Error(`Invalid aggregated balances - ${JSON.stringify(invalid)}`))
        }
        resolve()
      } catch (err) {
        reject(err)
      }
    })
  }

  const startWorkingOnTransmits = (filters) => {
    return new Promise(async (resolve, reject) => {
      try {
        let transmits = []
        if (filters && filters.currency) {
          let transmit = await osseus.db_models.transmit.workOn(filters.currency)
          transmits = [transmit]
        } else {
          const currencies = await osseus.db_models.currency.getAllCCs()
          const tasks = []
          currencies.forEach(currency => {
            tasks.push(new Promise(async (resolve, reject) => {
              let transmit = await osseus.db_models.transmit.workOn(currency.id)
              resolve(transmit)
            }))
          })
          transmits = await Promise.all(tasks, task => { return task })
        }
        resolve(transmits)
      } catch (err) {
        reject(err)
      }
    })
  }

  const getTransactionsToTransmit = (txids) => {
    return new Promise(async (resolve, reject) => {
      try {
        const filters = {
          _id: {$in: txids},
          context: 'transfer',
          state: 'DONE'
        }

        const projection = {
          'from.accountAddress': 1,
          'from.currency': 1,
          'to.accountAddress': 1,
          amount: 1
        }

        osseus.logger.debug(`filters: ${JSON.stringify(filters)}, projection: ${JSON.stringify(projection)}`)

        const nSelected = await osseus.db_models.tx.markAsSelected(filters)
        osseus.logger.debug(`marked as selected: ${nSelected} transactions`)

        filters.state = 'SELECTED'
        const transactions = await osseus.db_models.tx.getPopulated(filters, projection)
        osseus.logger.debug(`got ${transactions.length} transactions`)

        resolve(transactions)
      } catch (err) {
        reject(err)
      }
    })
  }

  const prepareTransactionsToBeTransmitted = (transactions, bctxOpts) => {
    return new Promise(async (resolve, reject) => {
      try {
        const transmitDataPerToken = {}
        transactions.forEach(transaction => {
          let txid = transaction._id.toString()
          let from = transaction.from.accountAddress
          let token = transaction.from.currency.currencyAddress
          let to = transaction.to.accountAddress
          let amount = new BigNumber(transaction.amount)

          osseus.logger.silly(`token: ${token}, txid: ${txid}, from: ${from}, to: ${to}, amount: ${amount.toNumber()}`)

          transmitDataPerToken[token] = transmitDataPerToken[token] || {}
          transmitDataPerToken[token][from] = (transmitDataPerToken[token][from] || new BigNumber(0)).minus(amount)

          transmitDataPerToken[token] = transmitDataPerToken[token] || {}
          transmitDataPerToken[token][to] = (transmitDataPerToken[token][to] || new BigNumber(0)).plus(amount)
        })

        const bctxs = []
        Object.keys(transmitDataPerToken).forEach(token => {
          let sum = new BigNumber(0)
          let negatives = []
          let positives = []
          Object.keys(transmitDataPerToken[token]).forEach(account => {
            let amount = transmitDataPerToken[token][account]
            sum = sum.plus(amount)
            if (amount > 0) {
              positives.push({account: account, amount: amount})
            } else if (amount < 0) {
              negatives.push({account: account, amount: amount})
            }
          })
          if (sum.toNumber() !== 0) {
            throw new Error(`Transactions for token: ${token} are not adding up to zero !!!`)
          }

          while (negatives.length > 0 && positives.length > 0) {
            let nObj = negatives[0]
            let pObj = positives.splice(0, 1)[0]
            nObj.amount += pObj.amount
            bctxs.push({from: nObj.account, to: pObj.account, amount: pObj.amount, token: token, opts: bctxOpts})
            if (nObj.amount < 0) {
              negatives.push(nObj)
            }
          }

          resolve(bctxs)
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  const transmitToBlockchain = (transmit, bctxs, txids) => {
    return new Promise(async (resolve, reject) => {
      try {
        const bctxJobs = await Promise.mapSeries(bctxs, async tx => {
          let bctxJob = osseus.agenda.now('bctx-transfer', {transmitId: transmit.id, tx: JSON.stringify(tx)})
          return bctxJob
        })

        osseus.logger.debug(`bctxJobs: ${JSON.stringify(bctxJobs)}`)
        osseus.logger.debug(`transaction ids to update: ${JSON.stringify(txids)}`)

        const nUpdated = await osseus.db_models.tx.markAsTransmitted(txids, transmit.id)
        osseus.logger.debug(`nUpdated: ${nUpdated}`)

        const updatedTransmit = await osseus.db_models.transmit.update(transmit.id, {state: 'DONE'})

        resolve({
          txs: txids,
          bctxJobs: bctxJobs,
          transmit: updatedTransmit,
          nUpdated: nUpdated
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  transaction.transfer = (from, to, amount, extra) => {
    return new Promise(async (resolve, reject) => {
      try {
        from = await validateParticipant(from)
        to = await validateParticipant(to)
        amount = await validateAmount(amount)

        const transmit = await osseus.db_models.transmit.getActive(from.currency)

        const data = {
          from: from,
          to: to,
          amount: amount,
          context: 'transfer',
          transmit: transmit.id
        }
        Object.assign(data, extra)
        const newTx = await osseus.db_models.tx.create(data)

        await osseus.db_models.transmit.addOffchainTransaction(transmit.id, newTx.id)

        resolve(newTx)
      } catch (err) {
        reject(err)
      }
    })
  }

  transaction.deposit = (to, amount, bctxid) => {
    return new Promise(async (resolve, reject) => {
      try {
        to = await validateParticipant(to)
        amount = await validateAmount(amount)

        const transmit = await osseus.db_models.transmit.create({currency: to.currency, state: 'DONE', offchainTransactions: [], blockchainTransactions: [bctxid]})

        const data = {
          to: to,
          amount: amount,
          transmit: transmit,
          context: 'deposit'
        }
        const newTx = await osseus.db_models.tx.createDeposit(data)

        await osseus.db_models.transmit.addOffchainTransaction(transmit.id, newTx.id)

        resolve(newTx)
      } catch (err) {
        reject(err)
      }
    })
  }

  transaction.transmit = (opts) => {
    return new Promise(async (resolve, reject) => {
      try {
        await validateAggregatedBalances()

        const transmits = await startWorkingOnTransmits(opts.filters)
        osseus.logger.debug(`found ${transmits.length} transmits to work on`)
        const tasks = []
        transmits.forEach(transmit => {
          osseus.logger.debug(`transmit: ${JSON.stringify(transmit)}`)
          transmit && tasks.push(new Promise(async (resolve, reject) => {
            const transactions = await getTransactionsToTransmit(transmit.offchainTransactions)
            osseus.logger.debug('transaction.transmit --> transaction', transactions)
            if (!transactions || transactions.length === 0) {
              await osseus.db_models.transmit.update(transmit.id, {state: 'DONE'})
              return resolve()
            }
            const txids = transactions.map(transaction => transaction._id.toString())
            osseus.logger.debug('transaction.transmit --> txids', txids)
            const bctxs = await prepareTransactionsToBeTransmitted(transactions, opts.bc)
            osseus.logger.debug('transaction.transmit --> bctxs', bctxs)
            const result = await transmitToBlockchain(transmit, bctxs, txids)
            osseus.logger.debug('transaction.transmit --> result', result)
            resolve(result)
          }))
        })

        let results = await Promise.all(tasks, task => { return task })
        results = results.filter(res => res)
        osseus.logger.debug(`results: ${JSON.stringify(results)}`)

        resolve(results)
      } catch (err) {
        reject(err)
      }
    })
  }

  return transaction
}
