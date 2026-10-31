"""Build RT_VERSION (VS_VERSIONINFO) and RT_MANIFEST resources.

A binary that presents real vendor metadata + a manifest is scored far lower by
Defender's ML models than a bare stripped Go executable.
"""

import struct

from peicon import RT_MANIFEST, RT_VERSION

MANIFEST_TEMPLATE = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="{identity}" version="{version}"
                    processorArchitecture="*"/>
  <description>{description}</description>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls"
                        version="6.0.0.0" processorArchitecture="*"
                        publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}}"/>
      <supportedOS Id="{{4f476546-9379-4f6b-9d2f-cda0e0b9e5e0}}"/>
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true</dpiAware>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
    </windowsSettings>
  </application>
</assembly>
"""


def _pad(b: bytes) -> bytes:
    return b + b"\0" * ((4 - len(b) % 4) % 4)


def _node(key: str, value: bytes = b"", value_len: int = 0, wtype: int = 0,
          children: bytes = b"") -> bytes:
    body = struct.pack("<HHH", 0, value_len, wtype)
    body += key.encode("utf-16-le") + b"\0\0"
    body = _pad(body)
    body += value
    body = _pad(body) + children
    return struct.pack("<H", len(body)) + body[2:]


def _string(key: str, value: str) -> bytes:
    data = value.encode("utf-16-le") + b"\0\0"
    return _node(key, data, len(value) + 1, 1)


def fixed_file_info(version) -> bytes:
    ms = (version[0] << 16) | version[1]
    ls = (version[2] << 16) | version[3]
    return struct.pack(
        "<IIIIIIIIIIIII",
        0xFEEF04BD, 0x00010000,      # signature / struct version
        ms, ls, ms, ls,              # file version / product version
        0x3F, 0,                     # flags mask / flags
        0x40004,                     # VOS_NT_WINDOWS32
        0x1, 0,                      # VFT_APP, no subtype
        0, 0)


def version_resource(company="Acme Software", product="Acme Updater",
                     description="Acme Updater", version=(1, 0, 0, 0),
                     internal_name="updater.exe", original_name="updater.exe",
                     legal="Copyright (C) Acme Software"):
    strings = b"".join([
        _string("CompanyName", company),
        _string("FileDescription", description),
        _string("FileVersion", "%d.%d.%d.%d" % version),
        _string("InternalName", internal_name),
        _string("LegalCopyright", legal),
        _string("OriginalFilename", original_name),
        _string("ProductName", product),
        _string("ProductVersion", "%d.%d.%d.%d" % version),
    ])
    table = _node("040904B0", wtype=1, children=strings)
    sfi = _node("StringFileInfo", wtype=1, children=table)
    translation = _node("Translation", struct.pack("<HH", 0x0409, 0x04B0), 4, 0)
    vfi = _node("VarFileInfo", wtype=1, children=translation)
    return _node("VS_VERSION_INFO", fixed_file_info(version), 52, 0, sfi + vfi)


def manifest(identity="Acme.Updater", version=(1, 0, 0, 0),
             description="Acme Updater") -> bytes:
    return MANIFEST_TEMPLATE.format(
        identity=identity,
        version="%d.%d.%d.%d" % version,
        description=description,
    ).replace("{{", "{").replace("}}", "}").encode()


def metadata_items(company="Acme Software", product="Acme Updater",
                   description="Acme Updater", version=(1, 0, 0, 0),
                   internal_name="updater.exe", original_name="updater.exe",
                   identity="Acme.Updater"):
    return [
        (RT_VERSION, 1, version_resource(company, product, description,
                                         version, internal_name, original_name)),
        (RT_MANIFEST, 1, manifest(identity, version, description)),
    ]
