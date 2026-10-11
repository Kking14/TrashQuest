# Hand detection and rewards

The gateway loads Hands Detection/best.onnx beside the selected waste model. A hand must be absent before movement. A confirmed hand during sorting forfeits only that disposal's points. The ESP32 finishes its ordinary cycle: the gateway sends no hand abort command. Earlier completed disposals remain claimable. Once the platform and inductive sensor clear, the station accepts another batch.

Hand detection uses two consecutive frames at 0.65 confidence. A camera slowdown during motion does not interrupt the motor. A clear camera reading is still required before starting a new batch.

Tin-can counting uses TQ_METAL_COUNT_CONFIDENCE (default 0.55) and a three-second stability window for slower AI inference. Other waste confidence remains unchanged. Keep cans separated and still; ambiguous or mixed waste remains rejected.

Restart the gateway after updating these files. No ESP32 firmware upload is required for the reward-only hand behavior. Test one and multiple cans, with and without a hand, and confirm that hand-flagged batches produce no claim while motors finish their ordinary cycle. There is no physical home switch or certified safety interlock.
