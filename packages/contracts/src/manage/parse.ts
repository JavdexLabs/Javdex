import { MANAGE_OPERATIONS, type ManageOperationId } from './operations'
import { MANAGE_OPERATION_INPUTS } from './inputs'
import {
  manageMutationEnvelopeSchema,
  manageQueryEnvelopeSchema,
  uuidSchema,
  digestSchema
} from './primitives'
import { z } from 'zod'

const claimEnvelope = z
  .object({
    serverId: uuidSchema,
    catalogId: uuidSchema,
    input: MANAGE_OPERATION_INPUTS['writer.claim']
  })
  .strict()

const publicEnvelope = <T extends z.ZodType>(input: T) =>
  z
    .object({
      serverId: uuidSchema.optional(),
      catalogId: uuidSchema.optional(),
      input
    })
    .strict()

const migrationEnvelope = <T extends z.ZodType>(input: T) =>
  z
    .object({
      migrationId: uuidSchema.optional(),
      digest: digestSchema.optional(),
      input
    })
    .strict()

export function manageRequestSchema(operation: ManageOperationId) {
  const meta = MANAGE_OPERATIONS[operation]
  const input = MANAGE_OPERATION_INPUTS[operation]
  if (operation === 'writer.claim') return claimEnvelope
  if (meta.auth === 'publicHandshake') return publicEnvelope(input)
  if (meta.auth === 'claim') return publicEnvelope(input)
  if (meta.auth === 'migration') return migrationEnvelope(input)
  if (meta.auth === 'manageRead') return manageQueryEnvelopeSchema(input)
  return manageMutationEnvelopeSchema(input)
}

export function parseManageRequest(operation: ManageOperationId, value: unknown) {
  return manageRequestSchema(operation).safeParse(value)
}

export function parseManageInput(operation: ManageOperationId, value: unknown) {
  return MANAGE_OPERATION_INPUTS[operation].safeParse(value)
}
