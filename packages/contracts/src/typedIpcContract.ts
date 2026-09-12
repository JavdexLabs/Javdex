export interface IpcCommandShape {
  args: unknown[]
  result: unknown
}

export type IpcCommandContract = Record<string, IpcCommandShape>
export type IpcEventContract = Record<string, unknown>

export type IpcContractChannel<Contract extends object> = keyof Contract & string
export type IpcContractArgs<
  Contract extends object,
  Channel extends IpcContractChannel<Contract>
> = Contract[Channel] extends { args: infer Args extends unknown[] } ? Args : never
export type IpcContractResult<
  Contract extends object,
  Channel extends IpcContractChannel<Contract>
> = Contract[Channel] extends { result: infer Result } ? Result : never

export type IpcEventChannel<Contract extends object> = keyof Contract & string
export type IpcEventPayload<
  Contract extends object,
  Channel extends IpcEventChannel<Contract>
> = Contract[Channel]
