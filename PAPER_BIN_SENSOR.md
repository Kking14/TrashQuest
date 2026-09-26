# Paper-bin Sharp sensor

The ESP32 sketch supports a Sharp GP2Y0A21YK0F (marked `2Y0A21 F`) analog distance sensor as the paper-bin fullness reader. GPIO35 is reserved for its analog signal. The existing plastic ultrasonic uses TRIG 27 / ECHO 14; the metal ultrasonic uses TRIG 16 / ECHO 34.

Connect the Sharp sensor's **Vcc to 5 V** and **GND to the ESP32's GND**. Do not connect its analog Vo directly to the ESP32. Use a divider: Vo → 10 kΩ → GPIO35; GPIO35 → 10 kΩ → GND. Both resistor legs and the GPIO35 wire must share the same electrical junction. If 10 kΩ resistors are unavailable, two equal-value resistors in the kΩ range give the same 1:2 ratio. Confirm the connector's Vcc/GND/Vo labels before applying power.

Mount the sensor pointing down at the paper surface. Its usable distance range is approximately **10–80 cm**; both the empty-bin floor and the full level should be within that range. The initial full threshold in the sketch is **20 cm** (`paperFullDistanceCm`). Measure the reported distance with the empty bin and then with paper at the intended full level, and adjust that threshold between those readings. The distance is estimated from the Sharp analog response, so it requires calibration in the actual bin. An unavailable reading will not clear a previously confirmed full condition.

The gateway reports the paper compartment separately; the admin dashboard names the paper bin when it fills. The station blocks new sorting when any of the three compartments is full.
