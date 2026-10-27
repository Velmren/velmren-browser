

/* this ALWAYS GENERATED file contains the IIDs and CLSIDs */

/* link this file in with the server and any clients */


 /* File created by MIDL compiler version 8.xx.xxxx */
/* at a redacted point in time
 */
/* Compiler settings for ../../brave/chromium_src/chrome/elevation_service/elevation_service_idl.idl:
    Oicf, W1, Zp8, env=Win64 (32b run), target_arch=AMD64 8.xx.xxxx 
    protocol : dce , ms_ext, c_ext, robust
    error checks: allocation ref bounds_check enum stub_data 
    VC __declspec() decoration level: 
         __declspec(uuid()), __declspec(selectany), __declspec(novtable)
         DECLSPEC_UUID(), MIDL_INTERFACE()
*/
/* @@MIDL_FILE_HEADING(  ) */

#pragma warning( disable: 4049 )  /* more than 64k source lines */


#ifdef __cplusplus
extern "C"{
#endif 


#include <rpc.h>
#include <rpcndr.h>

#ifdef _MIDL_USE_GUIDDEF_

#ifndef INITGUID
#define INITGUID
#include <guiddef.h>
#undef INITGUID
#else
#include <guiddef.h>
#endif

#define MIDL_DEFINE_GUID(type,name,l,w1,w2,b1,b2,b3,b4,b5,b6,b7,b8) \
        DEFINE_GUID(name,l,w1,w2,b1,b2,b3,b4,b5,b6,b7,b8)

#else // !_MIDL_USE_GUIDDEF_

#ifndef __IID_DEFINED__
#define __IID_DEFINED__

typedef struct _IID
{
    unsigned long x;
    unsigned short s1;
    unsigned short s2;
    unsigned char  c[8];
} IID;

#endif // __IID_DEFINED__

#ifndef CLSID_DEFINED
#define CLSID_DEFINED
typedef IID CLSID;
#endif // CLSID_DEFINED

#define MIDL_DEFINE_GUID(type,name,l,w1,w2,b1,b2,b3,b4,b5,b6,b7,b8) \
        EXTERN_C __declspec(selectany) const type name = {l,w1,w2,{b1,b2,b3,b4,b5,b6,b7,b8}}

#endif // !_MIDL_USE_GUIDDEF_

MIDL_DEFINE_GUID(IID, IID_IElevator,0x7FC9D551,0x5EEC,0x5C1F,0xB5,0x33,0xD3,0xFA,0x0C,0xB0,0xB4,0x4A);


MIDL_DEFINE_GUID(IID, IID_IElevator2,0x8D962E97,0xB282,0x535B,0x96,0xFC,0xA2,0x40,0x97,0x9B,0x6A,0x88);


MIDL_DEFINE_GUID(IID, IID_IElevatorChromium,0x3218DA17,0x49C2,0x479A,0x82,0x90,0x31,0x1D,0xBF,0xB8,0x64,0x90);


MIDL_DEFINE_GUID(IID, IID_IElevatorChrome,0x407578A3,0xC18B,0x5138,0xBB,0x1F,0xFB,0x3D,0x52,0x9F,0x1C,0x0D);


MIDL_DEFINE_GUID(IID, IID_IElevatorChromeBeta,0x25247D6B,0xB4A2,0x5ECB,0xBF,0xBB,0xD3,0xC3,0x29,0x53,0xF3,0x49);


MIDL_DEFINE_GUID(IID, IID_IElevatorChromeDev,0x3F6AAAF6,0xF875,0x5E3C,0xB0,0x54,0x2A,0x1D,0xEE,0x2F,0x78,0xCA);


MIDL_DEFINE_GUID(IID, IID_IElevatorChromeCanary,0xD236C5DF,0x36FF,0x5066,0x9C,0xB7,0xDC,0x69,0xEC,0x21,0xED,0xD0);


MIDL_DEFINE_GUID(IID, IID_IElevatorDevelopment,0xD9891B9B,0x1D2F,0x5944,0xB0,0x43,0x31,0x00,0x2A,0xDC,0x86,0x4E);


MIDL_DEFINE_GUID(IID, IID_IElevator2Chromium,0xBB19A0E5,0x00C6,0x4966,0x94,0xB2,0x5A,0xFE,0xC6,0xFE,0xD9,0x3A);


MIDL_DEFINE_GUID(IID, IID_IElevator2Chrome,0x1BF5208B,0x295F,0x4992,0xB5,0xF4,0x3A,0x9B,0xB6,0x49,0x48,0x38);


MIDL_DEFINE_GUID(IID, IID_IElevator2ChromeBeta,0xB96A14B8,0xD0B0,0x44D8,0xBA,0x68,0x23,0x85,0xB2,0xA0,0x32,0x54);


MIDL_DEFINE_GUID(IID, IID_IElevator2ChromeDev,0x3FEFA48E,0xC8BF,0x461F,0xAE,0xD6,0x63,0xF6,0x58,0xCC,0x85,0x0A);


MIDL_DEFINE_GUID(IID, IID_IElevator2ChromeCanary,0xFF672E9F,0x0994,0x4322,0x81,0xE5,0x3A,0x5A,0x97,0x46,0x14,0x0A);


MIDL_DEFINE_GUID(IID, LIBID_ElevatorLib,0xD91A9B0C,0xB5F9,0x506C,0x85,0x5C,0x3A,0xD5,0x9C,0xD9,0x78,0xAA);

#undef MIDL_DEFINE_GUID

#ifdef __cplusplus
}
#endif



