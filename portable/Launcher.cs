using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("주주명부 렌즈 무설치 실행기")]
[assembly: AssemblyDescription("동봉된 실행 엔진으로 주주명부 렌즈를 시작하거나 종료합니다.")]
[assembly: AssemblyProduct("주주명부 렌즈")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal static class Launcher
{
    private const int LaunchTimeoutMilliseconds = 45000;

    [STAThread]
    private static int Main(string[] args)
    {
        bool noBrowser = Array.IndexOf(args, "--no-browser") >= 0;
        foreach (string arg in args)
        {
            if (arg != "--no-browser")
                return ReportError("지원하지 않는 실행 옵션입니다: " + arg, noBrowser);
        }

        string root = AppDomain.CurrentDomain.BaseDirectory;
        string node = Path.Combine(root, "runtime", "node.exe");
        string script = Path.Combine(root, "app", "launcher.mjs");
        string logPath = Path.Combine(root, "data", "startup.log");
        if (!File.Exists(node) || !File.Exists(script))
        {
            return ReportError(
                "실행에 필요한 파일을 찾을 수 없습니다.\r\n\r\n" +
                "ZIP 파일을 먼저 모두 압축 해제한 뒤 실행해 주세요. " +
                "실행 파일만 다른 폴더로 옮기면 작동하지 않습니다.\r\n\r\n" +
                "실행 폴더: " + root,
                noBrowser);
        }

#if STOP
        string command = "--stop";
#else
        string command = "--start";
#endif

        StringBuilder output = new StringBuilder();
        object outputLock = new object();
        try
        {
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = node;
            info.Arguments = Quote(script) + " " + command + (noBrowser ? " --no-browser" : "");
            info.WorkingDirectory = root;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8;
            info.StandardErrorEncoding = Encoding.UTF8;
            // Ignore development-machine module loaders and globally injected Node flags.
            info.EnvironmentVariables["NODE_OPTIONS"] = "";
            info.EnvironmentVariables["NODE_PATH"] = "";

            using (Process child = new Process())
            {
                child.StartInfo = info;
                DataReceivedEventHandler capture = delegate(object sender, DataReceivedEventArgs e)
                {
                    if (e.Data != null)
                    {
                        lock (outputLock)
                        {
                            if (output.Length < 16000)
                                output.AppendLine(e.Data);
                        }
                    }
                };
                child.OutputDataReceived += capture;
                child.ErrorDataReceived += capture;
                if (!child.Start())
                    throw new InvalidOperationException("실행 엔진을 시작하지 못했습니다.");
                child.BeginOutputReadLine();
                child.BeginErrorReadLine();

                if (!child.WaitForExit(LaunchTimeoutMilliseconds))
                {
                    // Do not kill a process merely because startup took longer than expected.
                    return ReportError(
                        "실행 확인 시간이 초과되었습니다. 잠시 후 다시 실행해 주세요.\r\n\r\n" +
                        "오류 기록: " + logPath,
                        noBrowser);
                }
                child.WaitForExit();
                if (child.ExitCode != 0)
                {
                    string details;
                    lock (outputLock) { details = output.ToString().Trim(); }
                    if (details.Length > 2500)
                        details = details.Substring(details.Length - 2500);
                    return ReportError(
                        "주주명부 렌즈를 실행하거나 종료하지 못했습니다.\r\n\r\n" +
                        details + "\r\n\r\n오류 기록: " + logPath,
                        noBrowser);
                }
            }
            return 0;
        }
        catch (Exception error)
        {
            return ReportError(
                "주주명부 렌즈 실행 중 오류가 발생했습니다.\r\n\r\n" +
                error.Message + "\r\n\r\n오류 기록: " + logPath,
                noBrowser);
        }
    }

    private static string Quote(string value)
    {
        // File paths cannot contain quotes. The .mjs path has no trailing slash.
        return "\"" + value + "\"";
    }

    private static int ReportError(string message, bool noBrowser)
    {
        if (noBrowser)
            Console.Error.WriteLine(message);
        else
            MessageBox.Show(message, "주주명부 렌즈", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
    }
}
