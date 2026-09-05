import 'dotenv/config';
import { DataSource } from 'typeorm';
import { User } from '../project/users/entities/user.entity';
import { Room } from '../project/rooms/entities/room.entity';
import { RoomMember } from '../project/rooms/entities/room-member.entity';

const AppDataSource = new DataSource({
  type: 'postgres',

  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,

  entities: [User, Room, RoomMember],

  migrations: [__dirname + '/migrations/*{.ts,.js}'],

  synchronize: false,
});

export default AppDataSource;
