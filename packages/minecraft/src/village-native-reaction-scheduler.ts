import { ResidentNativeReactionPolicy } from './village-native-reaction-policy.ts';

export {
  ResidentNativeReactionPolicy,
  type ExpiredNativeReaction,
  type NativeReactionOrigin,
  type ReactionEnqueueResult,
  type ResidentNativeReaction,
  type ScheduledNativeReaction,
} from './village-native-reaction-policy.ts';

/** Backward-compatible per-resident facade; village integration uses the policy coordinator. */
export class ResidentNativeReactionScheduler extends ResidentNativeReactionPolicy {
  takeNext(residentId: string, now = Date.now()) {
    return this.takeNextFor(residentId, now);
  }
}
