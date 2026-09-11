# AK final static review

AJ follow-up against cumulative working tree, baseline4c953a9. Reviewers read only and did not run tests.

## Standards

Anscombe: no concrete blocker. Per-subscriber queue timer covers startup, queued execution and retirement barrier; independent expiration preserves coalesced subscribers. Execution clears wait timers; unified cleanup removes timers/listeners. Slot and termination barriers retained. Three mock-timer tests have substantive capacity, independence and no-send assertions.

## Spec

Ptolemy: no new race/resource leak identified. Last waiting subscriber removes only its flight, identity guard protects a new same-key flight; expiration never bypasses termination. 30 seconds is a queue deadline, not total request or native termination deadline. dispose pending remains a documented gap.
