import { Link, useParams } from 'react-router'
import MatchView from './MatchView'

export default function MatchPage() {
  const { id = '' } = useParams()
  return (
    <>
      <Link to="/lol/schedule" className="lol-back">
        ‹ 賽程
      </Link>
      <MatchView key={id} id={id} />
    </>
  )
}
