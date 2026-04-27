       IDENTIFICATION DIVISION.
       PROGRAM-ID. ONLINESVC.
       PROCEDURE DIVISION.
       MAIN.
           EXEC CICS
               LINK
               PROGRAM('CUSTSRV')
               TRANSID('C001')
               MAP('CUSTMAP')
           END-EXEC.
           GOBACK.
