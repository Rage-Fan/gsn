import Web3 from 'web3'
import { BlockNumber, Log, PastLogsOptions, provider, Transaction, TransactionReceipt } from 'web3-core'
import { EventData, PastEventOptions } from 'web3-eth-contract'
import { PrefixedHexString, TransactionOptions } from 'ethereumjs-tx'

import RelayRequest from '../common/EIP712/RelayRequest'
import paymasterAbi from '../common/interfaces/IPaymaster.json'
import relayHubAbi from '../common/interfaces/IRelayHub.json'
import forwarderAbi from '../common/interfaces/ITrustedForwarder.json'
import stakeManagerAbi from '../common/interfaces/IStakeManager.json'
import gsnRecipientAbi from '../common/interfaces/IRelayRecipient.json'

import { calculateTransactionMaxPossibleGas, event2topic } from '../common/utils'
import replaceErrors from '../common/ErrorReplacerJSON'
import {
  BaseRelayRecipientInstance,
  IPaymasterInstance,
  IRelayHubInstance,
  IRelayRecipientInstance,
  IStakeManagerInstance,
  ITrustedForwarderInstance
} from '../../types/truffle-contracts'

import { Address, IntString } from './types/Aliases'
import { GSNConfig } from './GSNConfigurator'
import GsnTransactionDetails from './types/GsnTransactionDetails'
import { BlockTransactionString } from 'web3-eth'
import Common from 'ethereumjs-common'

// Truffle Contract typings seem to be completely out of their minds
import TruffleContract = require('@truffle/contract')
import Contract = Truffle.Contract

type EventName = string

export const RelayServerRegistered: EventName = 'RelayServerRegistered'
export const StakeUnlocked: EventName = 'StakeUnlocked'
export const HubUnauthorized: EventName = 'HubUnauthorized'
export const StakePenalized: EventName = 'StakePenalized'

export default class ContractInteractor {
  private readonly IPaymasterContract: Contract<IPaymasterInstance>
  private readonly IRelayHubContract: Contract<IRelayHubInstance>
  private readonly IForwarderContract: Contract<ITrustedForwarderInstance>
  private readonly IStakeManager: Contract<IStakeManagerInstance>
  private readonly IRelayRecipient: Contract<BaseRelayRecipientInstance>

  private readonly web3: Web3
  private readonly provider: provider
  private readonly config: GSNConfig
  private rawTxOptions?: TransactionOptions
  private chainId?: number
  private networkId?: number
  private networkType?: string

  constructor (provider: provider, config: GSNConfig) {
    this.web3 = new Web3(provider)
    this.config = config
    this.provider = provider
    // @ts-ignore
    this.IPaymasterContract = TruffleContract({
      contractName: 'IPaymaster',
      abi: paymasterAbi
    })
    // @ts-ignore
    this.IRelayHubContract = TruffleContract({
      contractName: 'IRelayHub',
      abi: relayHubAbi
    })
    // @ts-ignore
    this.IForwarderContract = TruffleContract({
      contractName: 'ITrustedForwarder',
      abi: forwarderAbi
    })
    // @ts-ignore
    this.IStakeManager = TruffleContract({
      contractName: 'IStakeManager',
      abi: stakeManagerAbi
    })
    // @ts-ignore
    this.IRelayRecipient = TruffleContract({
      contractName: 'IRelayRecipient',
      abi: gsnRecipientAbi
    })
    this.IStakeManager.setProvider(this.provider, undefined)
    this.IRelayHubContract.setProvider(this.provider, undefined)
    this.IPaymasterContract.setProvider(this.provider, undefined)
    this.IForwarderContract.setProvider(this.provider, undefined)
    this.IRelayRecipient.setProvider(this.provider, undefined)
  }

  getProvider (): provider { return this.provider }

  getWeb3 (): Web3 { return this.web3 }

  async _init (): Promise<void> {
    const chain = await this.web3.eth.net.getNetworkType()
    console.log('== chain =', chain)
    this.chainId = await this.web3.eth.getChainId()
    this.networkId = await this.web3.eth.net.getId()
    this.networkType = await this.web3.eth.net.getNetworkType()
    // chain === 'private' means we're on ganache, and ethereumjs-tx.Transaction doesn't support that chain type
    this.rawTxOptions = getRawTxOptions(this.chainId, this.networkId, chain !== 'private' ? chain : 'mainnet')
  }

  // must use these options when creating Transaction object
  getRawTxOptions (): TransactionOptions {
    if (this.rawTxOptions == null) {
      throw new Error('_init not called')
    }
    return this.rawTxOptions
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async _createRecipient (address: Address): Promise<IRelayRecipientInstance> {
    return this.IRelayRecipient.at(address)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async _createPaymaster (address: Address): Promise<IPaymasterInstance> {
    return this.IPaymasterContract.at(address)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async _createRelayHub (address: Address): Promise<IRelayHubInstance> {
    return this.IRelayHubContract.at(address)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async _createForwarder (address: Address): Promise<ITrustedForwarderInstance> {
    return this.IForwarderContract.at(address)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async _createStakeManager (address: Address): Promise<IStakeManagerInstance> {
    return this.IStakeManager.at(address)
  }

  async getForwarder (recipientAddress: Address): Promise<Address> {
    const recipient = await this._createRecipient(recipientAddress)
    return recipient.getTrustedForwarder()
  }

  async getSenderNonce (sender: Address, forwarderAddress: Address): Promise<IntString> {
    const forwarder = await this._createForwarder(forwarderAddress)
    const nonce = await forwarder.getNonce(sender)
    return nonce.toString()
  }

  // TODO: currently the name is incorrect, as we call to 'canRelay'
  //  but the plan is to remove 'canRelay' and move all decision-making to Paymaster and Forwarder
  //  Also, as ARC does not return a value, `reverted` flag is unnecessary. This will be addressed soon.
  async validateAcceptRelayCall (
    relayRequest: RelayRequest,
    signature: PrefixedHexString,
    approvalData: PrefixedHexString): Promise<{ success: boolean, returnValue: string, reverted: boolean }> {
    const paymaster = await this._createPaymaster(relayRequest.relayData.paymaster)
    const relayHub = await this._createRelayHub(this.config.relayHubAddress)
    const relayRequestAbiEncode = this.encodeABI(relayRequest, signature, approvalData)
    const calldataSize = relayRequestAbiEncode.length

    const gasLimits = await paymaster.getGasLimits()
    const hubOverhead = await relayHub.getHubOverhead()
    const maxPossibleGas = calculateTransactionMaxPossibleGas({
      gasLimits,
      hubOverhead: hubOverhead.toNumber(),
      relayCallGasLimit: relayRequest.gasData.gasLimit,
      calldataSize,
      gtxdatanonzero: this.config.gtxdatanonzero
    })
    let success: boolean
    let returnValue: string
    try {
      ({
        // @ts-ignore
        success,
        // @ts-ignore
        returnValue
      } = await relayHub.canRelay(
        relayRequest,
        maxPossibleGas,
        gasLimits.acceptRelayedCallGasLimit,
        signature,
        approvalData
      ))
    } catch (e) {
      const message = e instanceof Error ? e.message : JSON.stringify(e, replaceErrors)
      return {
        success: false,
        reverted: true,
        returnValue: `canRelay reverted (should not happen): ${message}`
      }
    }
    return {
      success,
      returnValue,
      reverted: false
    }
  }

  encodeABI (relayRequest: RelayRequest, sig: PrefixedHexString, approvalData: PrefixedHexString): PrefixedHexString {
    // TODO: check this works as expected
    // @ts-ignore
    const relayHub = new this.IRelayHubContract('')
    return relayHub.contract.methods.relayCall(relayRequest, sig, approvalData).encodeABI()
  }

  topicsForManagers (relayManagers: Address[]): string[] {
    return Array.from(relayManagers.values(),
      (address: Address) => `0x${address.replace(/^0x/, '').padStart(64, '0').toLowerCase()}`
    )
  }

  async getPastEventsForHub (names: EventName[], extraTopics: string[], options: PastEventOptions): Promise<EventData[]> {
    const relayHub = await this._createRelayHub(this.config.relayHubAddress)
    return this._getPastEvents(relayHub.contract, names, extraTopics, options)
  }

  async getPastEventsForStakeManager (names: EventName[], extraTopics: string[], options: PastEventOptions): Promise<EventData[]> {
    const stakeManager = await this._createStakeManager(this.config.stakeManagerAddress)
    return this._getPastEvents(stakeManager.contract, names, extraTopics, options)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async _getPastEvents (contract: any, names: EventName[], extraTopics: string[], options: PastEventOptions): Promise<EventData[]> {
    const topics: string[][] = []
    const eventTopic = event2topic(contract, names)
    topics.push(eventTopic)
    if (extraTopics.length > 0) {
      topics.push(extraTopics)
    }
    return contract.getPastEvents('allEvents', Object.assign({}, options, { topics }))
  }

  async getPastLogs (options: PastLogsOptions): Promise<Log[]> {
    return this.web3.eth.getPastLogs(options)
  }

  async getBalance (address: Address): Promise<string> {
    return this.web3.eth.getBalance(address)
  }

  async getBlockNumber (): Promise<number> {
    return this.web3.eth.getBlockNumber()
  }

  async sendSignedTransaction (rawTx: string): Promise<TransactionReceipt> {
    return this.web3.eth.sendSignedTransaction(rawTx)
  }

  async estimateGas (gsnTransactionDetails: GsnTransactionDetails): Promise<number> {
    return this.web3.eth.estimateGas(gsnTransactionDetails)
  }

  async getGasPrice (): Promise<string> {
    return this.web3.eth.getGasPrice()
  }

  async getTransactionCount (address: string, defulatBlock?: BlockNumber): Promise<number> {
    return this.web3.eth.getTransactionCount(address)
  }

  async getTransaction (transactionHash: string): Promise<Transaction> {
    return this.web3.eth.getTransaction(transactionHash)
  }

  async getBlock (blockHashOrBlockNumber: BlockNumber): Promise<BlockTransactionString> {
    return this.web3.eth.getBlock(blockHashOrBlockNumber)
  }

  async getCode (address: string): Promise<string> {
    return this.web3.eth.getCode(address)
  }

  getChainId (): number {
    if (this.chainId == null) {
      throw new Error('_init not called')
    }
    return this.chainId
  }

  getNetworkId (): number {
    if (this.networkId == null) {
      throw new Error('_init not called')
    }
    return this.networkId
  }

  getNetworkType (): string {
    if (this.networkType == null) {
      throw new Error('_init not called')
    }
    return this.networkType
  }
}

/**
 * Ganache does not seem to enforce EIP-155 signature. Buidler does, though.
 * This is how {@link Transaction} constructor allows support for custom and private network.
 * @param chainId
 * @param networkId
 * @return {{common: Common}}
 */
export function getRawTxOptions (chainId: number, networkId: number, chain?: string): TransactionOptions {
  return {
    common: Common.forCustomChain(
      chain ?? 'mainnet',
      {
        chainId,
        networkId
      }, 'istanbul')
  }
}
