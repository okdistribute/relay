import debug from 'debug'
import { EventEmitter } from 'events'
import express from 'express'
import expressWs from 'express-ws'
import { Server as HttpServer, Socket } from 'net'
import WebSocket, { Data } from 'ws'
import { CLOSE, MESSAGE } from './constants'
import { deduplicate } from './lib/deduplicate'
import { intersection } from './lib/intersection'
import { pipeSockets } from './lib/pipeSockets'
import { ClientID, ConnectRequestParams, KeySet, Message } from './types'

const { app } = expressWs(express())
const logoPage = `
  <body style="background:black; display:flex; justify-content:center; align-items:center">
    <img src="https://raw.githubusercontent.com/local-first-web/branding/main/svg/relay-v.svg" width="50%" alt="@localfirst/relay logo"/>
  </body>`

interface ListenOptions {
  silent?: boolean
}

/**
 * This server provides two services:
 *
 * - **Introductions** (aka discovery): Alice or Bob can provide one or more document keys that
 *   they're interested in. If Alice is interested in the same key or keys as Bob, each will receive
 *   an `Introduction` message with the other's id. They can then use that information to connect.
 *
 * - **Connection**: Once introduced, Alice can request to connect with Bob on a given document key
 *   (can think of it as a 'channel'). If we get matching connection requests from Alice and Bob, we
 *   just pipe their sockets together.
 */
export class Server extends EventEmitter {
  port: number

  /**
   * In this context:
   * - `id` is always a peer id.
   * - `peer` is always a reference to a client's socket connection.
   * - `key` is always a document id (elsewhere referred to as a 'channel' or a 'discovery key'.
   */
  peers: Record<ClientID, WebSocket>
  keys: Record<ClientID, KeySet>

  /**
   * For two peers to connect, they both need to send a connection request, specifying both the
   * remote peer id and the document key. When we've gotten the request from Alice but not yet from
   * Bob, we temporarily store a reference to Alice's request in `holding`, and store any
   * messages from Bob in `messages`.
   */
  private holding: Record<ClientID, WebSocket>
  private messages: Record<ClientID, Data[]>

  /**
   * When we start listening, we keep a reference to the `httpServer` so we can close it if asked to.
   */
  private httpServer?: HttpServer

  private sockets: Socket[] = []

  private log: debug.Debugger

  constructor({ port = 8080 } = {}) {
    super()
    this.log = debug(`lf:relay${port}`)
    this.port = port
    this.peers = {}
    this.keys = {}
    this.holding = {}
    this.messages = {}
  }

  // DISCOVERY

  openIntroductionConnection(peer: WebSocket, id: ClientID) {
    this.log('introduction connection', id)
    this.peers[id] = peer

    peer.on(MESSAGE, this.receiveIntroductionRequest(id))
    peer.on(CLOSE, this.closeIntroductionConnection(id))

    this.emit('introductionConnection', id)
  }

  receiveIntroductionRequest(id: ClientID) {
    const A = id // A and B always refer to peer ids

    // An introduction request from the client will include a list of keys to join and/or leave.
    // We combine those keys with any we already have.
    const applyJoinAndLeave = (current: KeySet = [], join: KeySet = [], leave: KeySet = []) => {
      return current
        .concat(join) // add `join` keys
        .filter((key) => !leave.includes(key)) // remove `leave` keys
        .reduce(deduplicate, []) // filter out duplicates
    }

    // If we find another peer interested in the same key(s), we send both peers an introduction,
    // which they can use to connect
    const sendIntroduction = (A: ClientID, B: ClientID, keys: KeySet) => {
      const message = {
        type: 'Introduction',
        id: B, // the id of the other peer
        keys, // the key(s) both are interested in
      } as Message.Introduction
      if (this.peers[A]) this.peers[A].send(JSON.stringify(message))
      else this.log(`Can't send connect message to unknown peer`, A)
    }

    return (data: Data) => {
      const message = JSON.parse(data.toString())
      this.log('received introduction request %o', message)

      // honor join/leave requests
      const current = this.keys[A]
      const { join, leave } = message
      this.keys[A] = applyJoinAndLeave(current, join, leave)

      // if this peer (A) has interests in common with any existing peer (B), introduce them to each other
      for (const B in this.peers) {
        // don't introduce peer to themselves
        if (A !== B) {
          // find keys that both peers are interested in
          const commonKeys = intersection(this.keys[A], this.keys[B])
          if (commonKeys.length > 0) {
            this.log('notifying', A, B, commonKeys)
            sendIntroduction(A, B, commonKeys)
            sendIntroduction(B, A, commonKeys)
          }
        }
      }
    }
  }

  closeIntroductionConnection(id: ClientID) {
    return () => {
      delete this.peers[id]
      delete this.keys[id]
    }
  }

  // PEER CONNECTIONS

  openConnection({ peerA, A, B, key }: ConnectRequestParams) {
    // A and B always refer to peers' client ids.

    // These are string keys for identifying this request and the reciprocal request
    // (which may or may not have already come in)
    const AseeksB = `${A}:${B}:${key}`
    const BseeksA = `${B}:${A}:${key}`

    if (!this.holding[BseeksA]) {
      // We haven't heard from Bob yet; hold this connection
      this.log('holding connection for peer', AseeksB)

      this.holding[AseeksB] = peerA // hold Alice's socket ready
      this.messages[AseeksB] = [] // hold any messages Alice sends to Bob in the meantime

      peerA.on(MESSAGE, (message: Data) => {
        // hold on to incoming message from Alice for Bob
        if (this.messages[AseeksB]) this.messages[AseeksB].push(message)
      })

      peerA.on(CLOSE, () => {
        // clean up
        delete this.holding[AseeksB]
        delete this.messages[AseeksB]
      })
    } else {
      // We already have a connection request from Bob; hook them up
      this.log('found peer, connecting', AseeksB)

      const peerB = this.holding[BseeksA]

      // Send any stored messages
      this.messages[BseeksA].forEach((message) => peerA.send(message))

      // Pipe the two sockets together
      pipeSockets(peerA, peerB)

      // Don't need to hold the connection or messages any more
      delete this.holding[BseeksA]
      delete this.messages[BseeksA]
    }
  }

  // SERVER

  listen({ silent = false }: ListenOptions = {}) {
    return new Promise<void>((resolve) => {
      // It's nice to be able to hit this server from a browser as a sanity check
      app.get('/', (req, res, next) => {
        this.log('get /')
        res.send(logoPage)
        res.end()
      })

      // Introduction request
      app.ws('/introduction/:id', (ws, { params: { id } }) => {
        this.log('received introduction request', id)
        this.openIntroductionConnection(ws as WebSocket, id)
      })

      // Connection request
      app.ws('/connection/:A/:B/:key', (ws, { params: { A, B, key } }) => {
        this.log('received connection request', A, B)
        this.openConnection({ peerA: ws as WebSocket, A, B, key })
      })

      this.httpServer = app.listen(this.port, () => {
        const msg = `◆ Listening at http://localhost:${this.port}`
        if (!silent) console.log(msg)
        this.log(msg)
        this.emit('ready')
        resolve()
      })
      this.httpServer.on('connection', (socket) => this.sockets.push(socket))
    })
  }

  close() {
    return new Promise<void>((resolve) => {
      if (this.httpServer) {
        this.log('attempting httpServer.close')
        this.sockets.forEach((socket) => socket.destroy())
        this.httpServer.close(() => {
          this.log('closed')
          this.emit(CLOSE)
          resolve()
        })
      } else this.log('nothing to close!')
    })
  }
}
