G21 ; mm mode
G90 ; absolute positioning
M5 ; laser off
; Image engrave: 256x1 px, interval 0.1mm
; KERF:PREAMBLE_END
M4 S0
G0 X8.500 Y-0.050 S0
G1 X17.000 F1000 S329
G1 X25.500 S659
G1 X25.600 S1000
