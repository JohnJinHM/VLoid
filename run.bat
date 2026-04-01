@echo off

call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul

FOR /F "tokens=*" %%i IN ('python -c "import sys, os; print(os.path.join(sys.base_exec_prefix, 'libs'))"') DO set PYTHON_LIBS=%%i
FOR /F "tokens=*" %%i IN ('python -c "import sys, os; print(os.path.join(sys.base_exec_prefix, 'include'))"') DO set PYTHON_INCLUDE=%%i

call .venv\Scripts\activate

python main.py