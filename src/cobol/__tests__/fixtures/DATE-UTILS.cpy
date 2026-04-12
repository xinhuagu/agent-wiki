       01  WS-DATE-FIELDS.
           05  WS-CURRENT-DATE.
               10  WS-YEAR    PIC 9(4).
               10  WS-MONTH   PIC 9(2).
               10  WS-DAY     PIC 9(2).
           05  WS-FORMATTED-DATE  PIC X(10).
           05  WS-DATE-VALID      PIC X VALUE "Y".
               88  DATE-IS-VALID  VALUE "Y".
               88  DATE-INVALID   VALUE "N".
