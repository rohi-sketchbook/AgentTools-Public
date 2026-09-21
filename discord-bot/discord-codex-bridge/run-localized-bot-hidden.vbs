Option Explicit

Const HIDDEN_WINDOW = 0

Dim shell
Dim fileSystem
Dim powerShellPath
Dim supervisorScript
Dim workingDirectory
Dim commandLine
Dim exitCode

If WScript.Arguments.Count <> 3 Then
    WScript.Quit 2
End If

powerShellPath = WScript.Arguments(0)
supervisorScript = WScript.Arguments(1)
workingDirectory = WScript.Arguments(2)

Set fileSystem = CreateObject("Scripting.FileSystemObject")

If Not fileSystem.FileExists(powerShellPath) Then
    WScript.Quit 3
End If

If Not fileSystem.FileExists(supervisorScript) Then
    WScript.Quit 4
End If

If Not fileSystem.FolderExists(workingDirectory) Then
    WScript.Quit 5
End If

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = workingDirectory
commandLine = QuoteArgument(powerShellPath) _
    & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " _
    & QuoteArgument(supervisorScript)
exitCode = shell.Run(commandLine, HIDDEN_WINDOW, True)

WScript.Quit exitCode

Function QuoteArgument(value)
    QuoteArgument = Chr(34) & value & Chr(34)
End Function
