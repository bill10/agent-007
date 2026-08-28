@echo off
REM Windows shim: PATH lookup on Windows ignores the extensionless script next
REM to this file, so hand it to node explicitly.
node "%~dp0agent-007-job" %*
