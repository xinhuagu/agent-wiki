       IDENTIFICATION DIVISION.
       PROGRAM-ID. CUSTOMERDB.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-CUST-ID             PIC X(10).
       01  WS-CUST-NAME           PIC X(50).
       01  WS-CUST-BALANCE        PIC 9(9)V99.
       01  WS-NEW-BALANCE         PIC 9(9)V99.
       PROCEDURE DIVISION.
       FETCH-CUSTOMER.
           EXEC SQL
               SELECT CUST-NAME, BALANCE
                 INTO :WS-CUST-NAME, :WS-CUST-BALANCE
                 FROM CUSTOMER-TABLE
                WHERE CUST-ID = :WS-CUST-ID
           END-EXEC.
       UPDATE-BALANCE.
           EXEC SQL
               UPDATE CUSTOMER-TABLE
                  SET BALANCE = :WS-NEW-BALANCE
                WHERE CUST-ID = :WS-CUST-ID
           END-EXEC.
       INSERT-CUSTOMER.
           EXEC SQL
               INSERT INTO CUSTOMER-TABLE
                   (CUST-ID, CUST-NAME, BALANCE)
               VALUES
                   (:WS-CUST-ID, :WS-CUST-NAME, :WS-NEW-BALANCE)
           END-EXEC.
           GOBACK.
