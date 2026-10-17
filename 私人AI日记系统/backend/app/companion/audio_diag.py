# -*- coding: utf-8 -*-
"""音频设备诊断服务：枚举渲染端点（名称/默认/音量/静音）+ 播放系统测试音。"""
import ctypes
import math
import struct
import tempfile
import wave
import winsound
from ctypes import POINTER, byref, c_int, c_uint, c_float, c_ulong, c_ulonglong, c_ushort, c_byte, c_wchar_p, c_void_p, c_wchar, WINFUNCTYPE

HRESULT = ctypes.c_long
ole32 = ctypes.windll.ole32


def guid_bytes(s):
    s = s.replace('{', '').replace('}', '').replace('-', '')
    b = bytearray()
    b += bytes.fromhex(s[0:8])[::-1]
    b += bytes.fromhex(s[8:12])[::-1]
    b += bytes.fromhex(s[12:16])[::-1]
    b += bytes.fromhex(s[16:20])
    b += bytes.fromhex(s[20:32])
    return bytes(b)


class GUID(ctypes.Structure):
    _fields_ = [("Data1", c_ulong), ("Data2", c_ushort), ("Data3", c_ushort), ("Data4", c_byte * 8)]


ole32.CoCreateInstance.argtypes = [POINTER(GUID), c_void_p, c_uint, POINTER(GUID), POINTER(c_void_p)]
ole32.CoCreateInstance.restype = HRESULT
ole32.CoInitializeEx.argtypes = [c_void_p, c_ulong]
ole32.CoInitializeEx.restype = HRESULT


CLSID_MMDEVICE_ENUM = GUID()
ctypes.memmove(byref(CLSID_MMDEVICE_ENUM), guid_bytes('{BCDE0395-E52F-467C-8E3D-C4579291692E}'), 16)
IID_IMMDEVICE_ENUM = GUID()
ctypes.memmove(byref(IID_IMMDEVICE_ENUM), guid_bytes('{A95664D2-9614-4F35-A746-DE8DB63617E6}'), 16)
IID_IAUDIO_ENDPOINT_VOLUME = GUID()
ctypes.memmove(byref(IID_IAUDIO_ENDPOINT_VOLUME), guid_bytes('{5CDF2C82-841E-4546-9722-0CF74078229A}'), 16)


class PROPVARIANT(ctypes.Structure):
    _fields_ = [("vt", c_ushort), ("wReserved1", c_ushort), ("wReserved2", c_ushort), ("wReserved3", c_ushort),
                ("val", c_ulonglong)]


class PROPERTYKEY(ctypes.Structure):
    _fields_ = [("fmtid", GUID), ("pid", c_ulong)]


PKEY_DEVICE_FRIENDLYNAME = PROPERTYKEY()
ctypes.memmove(byref(PKEY_DEVICE_FRIENDLYNAME.fmtid), guid_bytes('{A45C254E-DF1C-4EFD-8020-67D146A850E0}'), 16)
PKEY_DEVICE_FRIENDLYNAME.pid = 14


class IUnknownVtbl(ctypes.Structure):
    _fields_ = [("QueryInterface", c_void_p), ("AddRef", c_void_p), ("Release", c_void_p)]


class IPropertyStoreVtbl(ctypes.Structure):
    _fields_ = [("unk", IUnknownVtbl), ("GetCount", c_void_p), ("GetAt", c_void_p),
                ("GetValue", c_void_p), ("SetValue", c_void_p), ("Commit", c_void_p)]


class IAudioEndpointVolumeVtbl(ctypes.Structure):
    _fields_ = [("unk", IUnknownVtbl),
                ("RegisterControlChangeNotify", c_void_p), ("UnregisterControlChangeNotify", c_void_p),
                ("GetChannelCount", c_void_p), ("SetMasterVolumeLevel", c_void_p), ("SetMasterVolumeLevelScalar", c_void_p),
                ("GetMasterVolumeLevel", c_void_p), ("GetMasterVolumeLevelScalar", c_void_p),
                ("SetChannelVolumeLevel", c_void_p), ("SetChannelVolumeLevelScalar", c_void_p),
                ("GetChannelVolumeLevel", c_void_p), ("GetChannelVolumeLevelScalar", c_void_p),
                ("SetMute", c_void_p), ("GetMute", c_void_p),
                ("GetVolumeStepInfo", c_void_p), ("GetVolumeRange", c_void_p), ("QueryHardwareSupport", c_void_p)]


class IMMDeviceVtbl(ctypes.Structure):
    _fields_ = [("unk", IUnknownVtbl),
                ("Activate", c_void_p), ("OpenPropertyStore", c_void_p), ("GetId", c_void_p), ("GetState", c_void_p)]


class IMMDeviceCollectionVtbl(ctypes.Structure):
    _fields_ = [("unk", IUnknownVtbl), ("GetCount", c_void_p), ("Item", c_void_p)]


class IMMDeviceEnumeratorVtbl(ctypes.Structure):
    _fields_ = [("unk", IUnknownVtbl),
                ("EnumAudioEndpoints", c_void_p), ("GetDefaultAudioEndpoint", c_void_p), ("GetDevice", c_void_p),
                ("RegisterEndpointNotificationCallback", c_void_p), ("UnregisterEndpointNotificationCallback", c_void_p)]


# ---- 函数指针类型（COM 方法）----
Release = WINFUNCTYPE(HRESULT, c_void_p)

EnumAudioEndpoints = WINFUNCTYPE(HRESULT, POINTER(IMMDeviceEnumeratorVtbl), c_int, c_int, POINTER(POINTER(IMMDeviceCollectionVtbl)))
GetDefaultAudioEndpoint = WINFUNCTYPE(HRESULT, POINTER(IMMDeviceEnumeratorVtbl), c_int, c_int, POINTER(POINTER(IMMDeviceVtbl)))
GetDevice = WINFUNCTYPE(HRESULT, POINTER(IMMDeviceEnumeratorVtbl), c_wchar_p, POINTER(POINTER(IMMDeviceVtbl)))

Activate = WINFUNCTYPE(HRESULT, POINTER(IMMDeviceVtbl), POINTER(GUID), c_uint, c_void_p, POINTER(c_void_p))
OpenPropertyStore = WINFUNCTYPE(HRESULT, POINTER(IMMDeviceVtbl), c_uint, POINTER(POINTER(IPropertyStoreVtbl)))
GetId = WINFUNCTYPE(HRESULT, POINTER(IMMDeviceVtbl), POINTER(POINTER(c_wchar)))
GetState = WINFUNCTYPE(HRESULT, POINTER(IMMDeviceVtbl), POINTER(c_uint))

GetCount = WINFUNCTYPE(HRESULT, POINTER(IMMDeviceCollectionVtbl), POINTER(c_uint))
Item = WINFUNCTYPE(HRESULT, POINTER(IMMDeviceCollectionVtbl), c_uint, POINTER(POINTER(IMMDeviceVtbl)))

GetValue = WINFUNCTYPE(HRESULT, POINTER(IPropertyStoreVtbl), POINTER(PROPERTYKEY), POINTER(PROPVARIANT))

GetMasterVolumeLevelScalar = WINFUNCTYPE(HRESULT, POINTER(IAudioEndpointVolumeVtbl), POINTER(c_float))
GetMute = WINFUNCTYPE(HRESULT, POINTER(IAudioEndpointVolumeVtbl), POINTER(c_int))


def com_call(iface, index, ftype, *args):
    """按 vtable 索引调用 COM 方法：cast 函数指针 → 调用（首参为接口指针）。"""
    vtbl = ctypes.cast(iface, POINTER(POINTER(c_void_p))).contents
    return ctypes.cast(vtbl[index], ftype)(iface, *args)


_pEnum = None


def _ensure_enumerator():
    global _pEnum
    if _pEnum is not None:
        return _pEnum
    ole32.CoInitializeEx(None, 2)
    ppEnum = c_void_p()
    hr = ole32.CoCreateInstance(byref(CLSID_MMDEVICE_ENUM), None, 1, byref(IID_IMMDEVICE_ENUM), byref(ppEnum))
    if hr != 0:
        raise RuntimeError("CoCreateInstance MMDeviceEnumerator failed hr=0x%08X" % (hr & 0xFFFFFFFF))
    pEnum = ctypes.cast(ppEnum, POINTER(IMMDeviceEnumeratorVtbl))
    _pEnum = pEnum
    return pEnum


def get_device_friendly_name(device):
    pps = POINTER(IPropertyStoreVtbl)()
    hr = com_call(device, 4, OpenPropertyStore, 0, byref(pps))  # OpenPropertyStore
    if hr != 0:
        return "?"
    pv = PROPVARIANT()
    hr = com_call(pps, 5, GetValue, byref(PKEY_DEVICE_FRIENDLYNAME), byref(pv))  # GetValue
    name = "?"
    if hr == 0:
        ptr = ctypes.c_void_p(pv.val)
        name = ctypes.wstring_at(ptr) if ptr.value else "?"
    com_call(pps, 2, Release)  # Release
    return name


def _get_device_id(device):
    pid = POINTER(POINTER(c_wchar))()
    try:
        if com_call(device, 5, GetId, byref(pid)) == 0 and pid.contents:  # GetId
            return ctypes.wstring_at(pid.contents)
    except Exception:
        pass
    return "?"


def _get_default_endpoint():
    pEnum = _ensure_enumerator()
    pDev = POINTER(IMMDeviceVtbl)()
    hr = com_call(pEnum, 4, GetDefaultAudioEndpoint, 0, 0, byref(pDev))  # GetDefaultAudioEndpoint
    if hr != 0:
        return None
    return pDev


def _enum_endpoints():
    pEnum = _ensure_enumerator()
    pColl = POINTER(IMMDeviceCollectionVtbl)()
    hr = com_call(pEnum, 3, EnumAudioEndpoints, 0, 1, byref(pColl))  # EnumAudioEndpoints
    if hr != 0:
        return []
    count = c_uint()
    com_call(pColl, 3, GetCount, byref(count))  # GetCount
    out = []
    for i in range(count.value):
        pDev = POINTER(IMMDeviceVtbl)()
        if com_call(pColl, 4, Item, i, byref(pDev)) == 0:  # Item
            out.append(pDev)
    com_call(pColl, 2, Release)  # Release
    return out


def _endpoint_volume(device):
    pp = c_void_p()
    hr = com_call(device, 3, Activate, byref(IID_IAUDIO_ENDPOINT_VOLUME), 1, None, byref(pp))  # Activate
    if hr != 0:
        return None
    pVol = ctypes.cast(pp, POINTER(IAudioEndpointVolumeVtbl))
    vol = c_float()
    mute = c_int()
    com_call(pVol, 9, GetMasterVolumeLevelScalar, byref(vol))  # GetMasterVolumeLevelScalar
    com_call(pVol, 15, GetMute, byref(mute))  # GetMute
    com_call(pVol, 2, Release)  # Release
    return vol.value, bool(mute.value)


def enumerate_output_devices():
    """返回输出设备列表 + 默认设备。"""
    result = {"ok": True, "default": None, "devices": []}
    default_dev = None
    try:
        default_dev = _get_default_endpoint()
        default_id = _get_device_id(default_dev) if default_dev else None
        if default_dev:
            result["default"] = {
                "name": get_device_friendly_name(default_dev),
                "id": default_id,
            }
        for dev in _enum_endpoints():
            did = _get_device_id(dev)
            name = get_device_friendly_name(dev)
            ev = _endpoint_volume(dev)
            is_default = bool(result["default"]) and name == result["default"].get("name")
            entry = {"name": name, "id": did, "is_default": is_default}
            if ev:
                entry["volume"] = int(ev[0] * 100)
                entry["muted"] = ev[1]
            else:
                entry["volume"] = None
                entry["muted"] = None
            result["devices"].append(entry)
            com_call(dev, 2, Release)  # Release
    except Exception as exc:  # noqa: BLE001
        result = {"ok": False, "error": str(exc), "devices": []}
    finally:
        if default_dev:
            com_call(default_dev, 2, Release)  # Release
    return result


def play_system_test_tone(freq: int = 440, seconds: float = 1.2):
    """用 winsound 播放测试音到系统默认设备。"""
    try:
        fr = 44100
        path = tempfile.gettempdir() + "\\mio_test_tone.wav"
        w = wave.open(path, "wb")
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(fr)
        frames = b""
        for i in range(int(fr * seconds)):
            v = int(14000 * math.sin(2 * math.pi * freq * i / fr))
            frames += struct.pack("<hh", v, v)
        w.writeframes(frames)
        w.close()
        winsound.PlaySound(path, winsound.SND_FILENAME)
        return {"ok": True, "freq": freq, "seconds": seconds}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}
