Option Explicit

Const HIDDEN_WINDOW = 0

Dim shell
Dim fileSystem
Dim nodePath
Dim scriptPath
Dim workingDirectory
Dim commandLine
Dim exitCode

If WScript.Arguments.Count <> 3 Then
    WScript.Quit 2
End If

nodePath = WScript.Arguments(0)
scriptPath = WScript.Arguments(1)
workingDirectory = WScript.Arguments(2)

Set fileSystem = CreateObject("Scripting.FileSystemObject")

If Not fileSystem.FileExists(nodePath) Then
    WScript.Quit 3
End If

If Not fileSystem.FileExists(scriptPath) Then
    WScript.Quit 4
End If

If Not fileSystem.FolderExists(workingDirectory) Then
    WScript.Quit 5
End If

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = workingDirectory
commandLine = QuoteArgument(nodePath) & " " & QuoteArgument(scriptPath)
exitCode = shell.Run(commandLine, HIDDEN_WINDOW, True)

WScript.Quit exitCode

Function QuoteArgument(value)
    QuoteArgument = Chr(34) & value & Chr(34)
End Function
