/**
 * An in-memory capability issued by the host after lexical and realpath checks.
 * Local paths remain private to the capability implementation and never enter
 * shared IPC or persisted candidate JSON.
 */
declare const managedRootFileCapabilityBrand: unique symbol

export interface ManagedRootFileCapability {
  readonly [managedRootFileCapabilityBrand]: true
}
