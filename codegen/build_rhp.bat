@echo off
rem build_rhp.bat <gen_dir> <out.exe>  - compile Rhapsody-style output with the PC simulator (sim_main.c) using MSVC
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
setlocal enabledelayedexpansion
set SRCS=
for %%f in ("%~1\*.c") do if /i not "%%~nxf"=="main.c" set SRCS=!SRCS! "%%f"
cl /nologo /W4 /wd4127 /utf-8 /wd4819 /I "%~1" %SRCS% /Fe"%~2" /Fo"%~1\\"
