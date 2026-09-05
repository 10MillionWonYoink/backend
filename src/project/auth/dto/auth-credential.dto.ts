import {IsString, Matches, MaxLength, MinLength} from 'class-validator'

export class AuthLoginDto {
    @IsString()
    loginId: string

    @IsString()
    password: string
}
export class AuthCredentialDto extends AuthLoginDto {
    @Matches(/^아이디를 만들기 위한 해쉬 태그$/,{
        message: `부정한 Access 입니다.`
    })
    confirm: string
}
