G21 ; mm mode
G90 ; absolute positioning
M5 ; laser off
; Image engrave: 4x1 px, interval 1mm
; KERF:PREAMBLE_END
G0 X0.000 Y50.000
M3 S1000
G1 X1.000 Y50.000 F3000 S1000
G1 X2.000 Y50.000 F3000 S0
G1 X3.000 Y50.000 F3000 S1000
