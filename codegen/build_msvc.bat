@echo off
rem build_msvc.bat <gen_dir> <main.c> <out.exe>   - compile generated code with MSVC
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
cl /nologo /W3 /I "%~1" "%~1\*.c" "%~2" /Fe"%~3" /Fo"%~1\\"
